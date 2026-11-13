/**
 * Extension actions (RFC v3 "Actions"): synchronous business logic the engine
 * serves at `POST /ext/<name>/actions/<action>`.
 *
 * The manifest declares each one — a permission, a JSON Schema input, the
 * collections it reads and writes — and the module implements it. The engine
 * owns everything around the function: the caller's Casbin check, the input
 * validation, the data path (`ActionHost.collections`, the data API as the
 * caller), the request transaction it runs in, and the audit row.
 */

import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type {
  ActionHost,
  DataApiAnswer,
  DataApiReadQuery,
  ExtensionAction,
  HostCollections,
  RefusalStatus,
  RouteHost,
  UpdateExpect,
  ZveltioExtension,
} from '@zveltio/sdk/extension';
import { getDb } from '../../db/index.js';
import { auditLog } from '../audit.js';
import { problem } from '../problem.js';
import {
  asAdmittedKey,
  gateAdmitsAction,
  gatePrincipal,
  publicRouteRequest,
} from '../../middleware/extension-auth-gate.js';
import { afterRequestSettles } from '../../middleware/tenant.js';
import type { ExtensionManifest } from './manifest-schema.js';
import { CapabilityDeniedError, holdsCapability } from './capabilities.js';
import { ANY_COLLECTION } from '../manifest-capabilities.js';
import { actionWrites, type ExtensionContext, type ExtensionInternals } from './internals.js';
import { enqueueJob, extensionPrincipal, jobData } from './jobs.js';
import { admitFileGrant, type FileGrant } from './file-grants.js';
import { callerFiles } from './caller-files.js';
import { systemCollectionsFor } from './as-system.js';
import {
  asIdentityOn,
  DEFAULT_TENANT_ID,
  effectiveTimeZone,
  encodeApiKeyScopes,
  getCurrentTenantTrx,
  issuerRowIdentity,
  keyIssuerRowActor,
  rowActor,
} from '../tenancy/index.js';
import { activeForRequest } from './activation.js';
import { withSavepoint } from '../savepoint.js';
import { asEngineRole } from '../role-window.js';
import {
  DDLManager,
  decryptField,
  isApiKeyPrincipal,
  normalizeFields,
  type RequestUser,
  rowAuthorId,
} from '../data/index.js';
import type { Database } from '../../db/index.js';
import type { GatePrincipal } from '../../middleware/extension-auth-gate.js';

export interface CompiledAction {
  name: string;
  permission: { resource: string; action: string };
  input: z.ZodType;
  /** `input` as the manifest declares it (JSON Schema), for `GET /api/actions`. */
  inputSchema: Record<string, unknown>;
  reads: ReadonlySet<string>;
  writes: ReadonlySet<string>;
  /** The jobs `ActionHost.enqueue` may queue. */
  enqueues: ReadonlySet<string>;
  /** The other extensions' actions `ActionHost.actions.run` may run, as `<extension>.<action>`. */
  calls: ReadonlySet<string>;
  run: ExtensionAction;
}

/**
 * Pair a manifest list with the module's implementations by name, compiling
 * each input schema. Throws through `refuse` on any mismatch, in either direction.
 */
export function pairImplementations<D extends { name: string; input: Record<string, unknown> }, F>(
  kind: 'action' | 'job',
  declared: readonly D[],
  implemented: Record<string, F>,
  refuse: (why: string) => never,
): { declared: D; input: z.ZodType; run: F }[] {
  const out = declared.map((d) => {
    const run = Object.hasOwn(implemented, d.name) ? implemented[d.name] : undefined;
    if (typeof run !== 'function') refuse(`manifest ${kind} "${d.name}" has no implementation`);
    return { declared: d, input: compileInput(kind, d, refuse), run: run as F };
  });
  for (const name of Object.keys(implemented)) {
    if (!declared.some((d) => d.name === name)) {
      refuse(`${kind} "${name}" is implemented but not declared in the manifest`);
    }
  }
  return out;
}

/** A declared input JSON Schema as zod; refuses one zod cannot use. */
export function compileInput(
  kind: 'action' | 'job',
  d: { name: string; input: Record<string, unknown> },
  refuse: (why: string) => never,
): z.ZodType {
  try {
    return z.fromJSONSchema(d.input as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (err) {
    return refuse(
      `${kind} "${d.name}": input is not a usable JSON Schema (${(err as Error).message})`,
    );
  }
}

/**
 * Pair the manifest's actions with the module's implementations, compiling each
 * input schema. Throws — refusing the load — on any mismatch, in either
 * direction, and for an extension whose actions could not be served inline in
 * the request transaction: a worker-isolated one runs its code elsewhere, and
 * a `global` one has no sub-app to mount them on ahead of its own middleware.
 */
export function compileActions(
  extName: string,
  manifest: ExtensionManifest | null,
  extension: ZveltioExtension,
  worker: boolean,
): Map<string, CompiledAction> {
  const declared = manifest?.actions ?? [];
  const implemented = extension.actions ?? {};
  const out = new Map<string, CompiledAction>();
  if (declared.length === 0 && Object.keys(implemented).length === 0) return out;
  const refuse = (why: string): never => {
    throw new Error(`Extension "${extName}": ${why}`);
  };
  // When they are: an ActionRefusal is recognised by a Symbol.for property, which
  // a structured clone drops — carry status and code across explicitly, or every
  // refusal from a worker answers 500.
  if (worker) refuse('actions are not served for a worker-isolated extension yet');
  if (extension.mountStrategy !== 'subapp') refuse("actions need mountStrategy 'subapp'");
  for (const { declared: a, input, run } of pairImplementations(
    'action',
    declared,
    implemented,
    refuse,
  )) {
    out.set(a.name, {
      name: a.name,
      permission: a.permission,
      input,
      inputSchema: a.input,
      reads: new Set(a.reads),
      writes: new Set(a.writes),
      enqueues: new Set(a.enqueues),
      calls: new Set(a.calls),
      run,
    });
  }
  return out;
}

/**
 * Mount the actions route. Call BEFORE the extension's own `register()`: Hono
 * runs handlers in registration order, so a `use('*')` the extension adds later
 * never sees an action request, and cannot answer for one or rewrite it.
 */
export function mountActions(
  sub: Hono,
  extName: string,
  actions: ReadonlyMap<string, CompiledAction>,
  ctx: ExtensionContext,
): void {
  served.delete(extName);
  if (actions.size === 0) return;
  served.set(extName, { actions, ctx });
  sub.post('/actions/:name', async (c) => {
    const def = actions.get(c.req.param('name'));
    if (!def) return c.json({ error: 'Not found' }, 404);
    // Who the gate admitted, recorded before any extension code ran — never `c.get('user')`.
    const p = gatePrincipal(c);
    if (!p) return c.json({ error: 'Unauthorized', code: 'EXT_AUTH_REQUIRED' }, 401);
    // Without the request transaction each write would commit on its own, and a
    // throw half-way would keep the first half.
    if (!p.trx) throw new Error(`action ${extName}/${def.name}: this request holds no transaction`);
    if (!(await mayRunAction(p.user, extName, def, ctx))) {
      const { resource, action } = def.permission;
      return c.json({ error: 'Forbidden', code: 'permission_required', resource, action }, 403);
    }
    // `$files` is the engine's (ADR 0032): the stored files the caller hands a
    // job, taken out before the input schema sees the body.
    const body: unknown = await c.req.json().catch(() => undefined);
    const handed = hasFiles(body) ? body.$files : undefined;
    const parsed = def.input.safeParse(hasFiles(body) ? withoutFiles(body) : body);
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    // As the caller, before the action's code runs.
    const grant = hasFiles(body)
      ? await admitFileGrant(p.trx, p.user, p.tenantId ?? DEFAULT_TENANT_ID, handed)
      : undefined;
    auditAction(c, p, extName, def.name, undefined, grant);
    let result: unknown;
    try {
      const files = grant && { grant, used: false };
      result = await def.run(
        parsed.data,
        await actionHost(c, p, p.trx, extName, def, ctx, true, files),
      );
    } catch (err) {
      throw refusalProblem(err) ?? err;
    }
    return c.json({ result: result ?? null });
  });
}

/**
 * Each loaded extension's actions, with the context they run in, for
 * `ActionHost.actions.run`. Kept by `mountActions`, dropped by `forgetActions` on unload.
 */
const served = new Map<
  string,
  { actions: ReadonlyMap<string, CompiledAction>; ctx: ExtensionContext }
>();

export function forgetActions(extName: string): void {
  served.delete(extName);
}

/**
 * May `user` run `extName`'s action `def`: the extension gate admits them to its
 * route (for a key, `$ext:<extName>` for the action) and `ctx.checkPermission`
 * grants `def.permission` (for a key, also its issuer). THE one answer — the
 * action route, a called action and `GET /api/actions` all ask this, so the list
 * cannot drift from what the route admits (ADR 0029).
 */
export async function mayRunAction(
  user: RequestUser,
  extName: string,
  def: Pick<CompiledAction, 'name' | 'permission'>,
  ctx: Pick<ExtensionContext, 'checkPermission'>,
): Promise<boolean> {
  if (!gateAdmitsAction(extName, def.name, user)) return false;
  const { resource, action } = def.permission;
  const granted = await asAdmittedKey(user, () => ctx.checkPermission(user.id, resource, action));
  // On the route, `fenceAdminGrant` throws first: an `admin` grant needs a
  // session's step-up window, which a key never has. Off it, refuse the key here.
  return granted && !(resource === 'admin' && isApiKeyPrincipal(user));
}

/** `GET /api/actions` (ADR 0029): the actions `user` may run, of the extensions active for `c`'s tenant. */
export async function listRunnableActions(
  c: Context,
  user: RequestUser,
  db: Database,
): Promise<{ extension: string; name: string; input: Record<string, unknown> }[]> {
  const out: { extension: string; name: string; input: Record<string, unknown> }[] = [];
  for (const [extension, { actions, ctx }] of served) {
    // A switched-off extension answers 404 on the route, as one never installed.
    if (!(await activeForRequest(c, extension, db))) continue;
    for (const def of actions.values()) {
      if (await mayRunAction(user, extension, def, ctx)) {
        out.push({ extension, name: def.name, input: def.inputSchema });
      }
    }
  }
  return out;
}

/** After the transaction ends, on the pool: a failure rolls back the request's own writes, and the row recording it must survive that. */
function auditAction(
  c: Context,
  p: GatePrincipal,
  extName: string,
  action: string,
  /** A called action's own failure, which its caller may have caught. */
  threw: () => boolean = () => false,
  /** The stored files the caller handed it (ADR 0032). */
  files?: FileGrant,
): void {
  afterRequestSettles(c, () =>
    auditLog(getDb(), {
      type: 'extension.action.executed',
      userId: p.user.id,
      resourceType: 'extension_action',
      resourceId: `${extName}:${action}`,
      metadata: {
        extension: extName,
        action,
        outcome: c.res.status < 400 && !threw() ? 'success' : 'failure',
        status: c.res.status,
        ...(files ? { files: { read: files.read, write: files.write?.name ?? null } } : {}),
      },
      tenantId: p.tenantId,
    }),
  );
}

/**
 * The host `def` runs with. `mayCall`: the action was called over HTTP, so it may
 * run the actions its manifest lists in `calls` — one level deep, which is all
 * ADR 0014 needs; a called action that calls again throws. `files`: the
 * request's `$files`, for one `enqueue` (ADR 0032); a called action has none.
 */
async function actionHost(
  c: Context,
  p: GatePrincipal,
  trx: NonNullable<GatePrincipal['trx']>,
  extName: string,
  def: CompiledAction,
  ctx: ExtensionContext,
  mayCall: boolean,
  files?: { grant: FileGrant; used: boolean },
): Promise<ActionHost> {
  return {
    // On the request's transaction, not the pool: a second connection taken
    // while this one is held is how the engine stands still at c = DB_POOL_MAX.
    timezone: await effectiveTimeZone(trx, p.tenantId),
    collections: hostCollections(
      `action "${def.name}"`,
      def,
      callerData(c, ctx.internals, extName),
      secretReveal(trx, p.tenantId, extName),
      // ADR 0047: `"*"` only here, where `callerData` is the data API as the
      // caller and nothing else — not on a route's host, nor a job's.
      (kind) => {
        if (!holdsCapability(extName, ANY_COLLECTION[kind])) {
          throw new Error(
            `action "${def.name}" lists "*" in ${kind}, which needs the consent ` +
              `"${ANY_COLLECTION[kind]}": no administrator has approved it ` +
              `(POST /api/marketplace/${extName}/approve-capabilities)`,
          );
        }
      },
    ),
    enqueue: async (job, input, options) => {
      const refuse = (why: string): never => {
        throw new Error(`action "${def.name}" could not enqueue job "${job}": ${why}`);
      };
      const o = options as Record<string, unknown> | undefined;
      const valid =
        o === undefined ||
        (typeof o === 'object' &&
          o !== null &&
          Object.keys(o).every((k) => k === 'files') &&
          (o.files === undefined || o.files === true));
      if (!valid) refuse('its options are { files: true }; no form of enqueue takes file ids');
      if (o?.files !== true) return enqueueJob(extName, p, def, job, input);
      if (!files) {
        refuse(
          mayCall
            ? 'the request carried no $files'
            : 'it was run by another action, which hands it no files',
        );
      }
      // Taken before the await: two enqueues in flight cannot both receive it.
      if (files!.used) refuse("the request's $files already went to another job");
      files!.used = true;
      return enqueueJob(extName, p, def, job, input, files!.grant);
    },
    actions: {
      run: async (extension, action, input) => {
        const call = `${extension}.${action}`;
        if (!mayCall || !def.calls.has(call)) {
          throw new Error(
            mayCall
              ? `action "${def.name}" ran "${call}", which its manifest does not list in calls`
              : `action "${def.name}" was itself run by another action, and cannot run "${call}"`,
          );
        }
        // An absent or switched-off extension answers as the HTTP route does: not found.
        const target = served.get(extension);
        const called = target?.actions.get(action);
        if (!target || !called || !(await activeForRequest(c, extension, getDb()))) {
          throw problem('not_found', 404, `No action "${call}" is available.`);
        }
        // The same checks as `POST /ext/<extension>/actions/<action>`, for the same
        // caller, through the called extension's own context.
        const { resource, action: verb } = called.permission;
        if (!(await mayRunAction(p.user, extension, called, target.ctx))) {
          throw problem(
            'permission_required',
            403,
            `Running "${call}" needs "${verb}" on "${resource}".`,
          );
        }
        // Only the user hands files, over HTTP; a dependency never receives
        // files handed to another extension (ADR 0032).
        if (hasFiles(input)) {
          throw problem('invalid_input', 400, `$files is not an input of "${call}".`);
        }
        const parsed = called.input.safeParse(input);
        if (!parsed.success) {
          throw problem('invalid_input', 400, `Invalid input for "${call}".`, parsed.error.issues);
        }
        let threw = false;
        auditAction(c, p, extension, action, () => threw);
        const host = await actionHost(c, p, trx, extension, called, target.ctx, false);
        // Its writes carry `extension`'s mark, so a field ADR 0013 keeps for the
        // called extension's actions accepts them. A refusal it throws reaches the
        // caller unchanged, to catch or to let answer the request — and in a
        // savepoint, so what it wrote before throwing goes with it, as over HTTP:
        // a caller that catches must not keep half of the owner's invariant.
        return withSavepoint(
          trx,
          'zv_called_action',
          () => called.run(parsed.data, host),
          (err) => {
            threw = true;
            throw err;
          },
        );
      },
    },
  };
}

/** A request body carrying the engine's `$files` (ADR 0032). */
function hasFiles(body: unknown): body is { $files: unknown } {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    Object.hasOwn(body, '$files')
  );
}

function withoutFiles(body: { $files: unknown }): Record<string, unknown> {
  const { $files: _, ...rest } = body as Record<string, unknown>;
  return rest;
}

// The SDK's `ACTION_REFUSAL`, by its registered key: the engine imports only
// types from the SDK, and the compiled binary does not resolve it at runtime.
const ACTION_REFUSAL = Symbol.for('zveltio.extension.action-refusal');
/** The SDK's `RefusalStatus` — the record's keys must be exactly that union, so the two cannot drift. */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set(
  Object.keys({
    400: 1,
    403: 1,
    404: 1,
    409: 1,
    410: 1,
    412: 1,
    422: 1,
    423: 1,
    429: 1,
  } satisfies Record<RefusalStatus, 1>).map(Number),
);

/**
 * An `ActionRefusal` the action threw, as the problem its caller gets — still a
 * throw, so the request transaction rolls back what the action wrote. Only the
 * SDK's `RefusalStatus` set: an extension cannot answer 2xx through a throw, nor
 * dress a failure up as 401 (which Studio takes for a lost session). Anything
 * else stays a 500.
 */
export function refusalProblem(err: unknown): Error | null {
  if (typeof err !== 'object' || err === null) return null;
  const r = err as {
    [ACTION_REFUSAL]?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (r[ACTION_REFUSAL] !== true) return null;
  const { status } = r;
  if (typeof status !== 'number' || !REFUSAL_STATUSES.has(status)) return null;
  const code =
    typeof r.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(r.code) ? r.code : 'action_refused';
  return problem(code, status, typeof r.message === 'string' ? r.message.slice(0, 500) : undefined);
}

/** One data API call per member of `HostCollections`, answering with the route's status and body. */
export interface DataIo {
  read(collection: string, id: string): Promise<DataApiAnswer>;
  list(collection: string, query?: DataApiReadQuery): Promise<DataApiAnswer>;
  create(collection: string, data: Record<string, unknown>): Promise<DataApiAnswer>;
  update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
    expect?: UpdateExpect,
  ): Promise<DataApiAnswer>;
  delete(collection: string, id: string): Promise<DataApiAnswer>;
}

/**
 * The data API as the request's caller. Writes carry `extName` as the action's
 * extension (`WriteRequest.writtenBy`), bound here in the closure, so a nested
 * or concurrent action keeps its own mark; they need `data:write` as
 * `ctx.internals.*Record` do.
 */
function callerData(c: Context, internals: ExtensionInternals, extName: string): DataIo {
  const w = actionWrites(extName);
  const may = (member: string) => {
    if (!holdsCapability(extName, 'data:write')) {
      throw new CapabilityDeniedError(extName, 'data:write', member);
    }
  };
  return {
    read: (collection, id) => internals.readRecord(c, collection, id),
    list: (collection, query) => internals.listRecords(c, collection, query),
    create: async (collection, data) => {
      may('createRecord');
      return w.create(c, collection, '', data);
    },
    update: async (collection, id, data, expect) => {
      may('updateRecord');
      return w.update(c, collection, id, data, expect);
    },
    delete: async (collection, id) => {
      may('deleteRecord');
      return w.delete(c, collection, id, {});
    },
  };
}

/** Adds a collection's secret fields to the records a read found, when the reader owns them. */
export type SecretReveal = (
  collection: string,
  records: Record<string, unknown>[],
) => Promise<void>;

/**
 * ADR 0024 §4: the plaintext of a collection's `secret` fields, for the
 * extension that owns the collection (`zvd_collections.owner_extension`) and no
 * one else. The rows are the ones the caller's data API read returned — tenancy,
 * RLS and row rules decided those; the values are read by their ids in this
 * tenant, as the table owner, because the column is sealed from request roles.
 */
export function secretReveal(
  trx: Database,
  tenantId: string | null,
  extName: string,
): SecretReveal {
  return async (collection, records) => {
    const def = await DDLManager.getCollection(trx, collection);
    if (!tenantId || def?.owner_extension !== extName) return;
    const secrets = normalizeFields(def)
      .filter((f) => f.type === 'secret')
      .map((f) => f.name);
    const ids = records.map((r) => r.id).filter((id): id is string => typeof id === 'string');
    if (secrets.length === 0 || ids.length === 0) return;
    const rows = await asEngineRole(trx, () =>
      trx
        .selectFrom(DDLManager.getTableName(collection) as never)
        .select(['id', ...secrets] as never)
        .where('id' as never, 'in', ids as never)
        .where('tenant_id' as never, '=', tenantId as never)
        .execute(),
    );
    const byId = new Map((rows as Record<string, unknown>[]).map((r) => [String(r.id), r]));
    for (const record of records) {
      const row = byId.get(String(record.id));
      if (!row) continue;
      for (const name of secrets) {
        const v = row[name];
        // A value the current key cannot open reads as unset, as `maybeDecrypt`
        // keeps a record readable: recovery is writing a new one.
        record[name] =
          typeof v === 'string'
            ? await decryptField(v).catch((err: Error) => {
                console.error(`[secret] ${collection}.${name}: cannot decrypt — ${err.message}`);
                return null;
              })
            : null;
      }
    }
  };
}

/**
 * `io`, narrowed to the collections `def` declares; a refused call throws.
 * `anyCollection`: the caller passes it only where `io` is the data API as the
 * caller (an action, ADR 0047) — then `"*"` in `def` reaches every collection,
 * once it returns (it throws to refuse). Without it `"*"` matches nothing.
 */
export function hostCollections(
  what: string,
  def: { reads: ReadonlySet<string>; writes: ReadonlySet<string> },
  io: DataIo,
  reveal: SecretReveal,
  anyCollection?: (kind: 'reads' | 'writes') => void,
): HostCollections {
  const declared = (kind: 'reads' | 'writes', collection: string) => {
    if (def[kind].has(collection)) return;
    if (anyCollection && def[kind].has('*')) return anyCollection(kind);
    throw new Error(
      `${what} reached collection "${collection}", which its manifest does not list in ${kind}`,
    );
  };
  // A refused write fails the action or job, so its transaction rolls back what it wrote before.
  const ok = (a: DataApiAnswer): Record<string, unknown> => {
    if (a.status < 400) return a.body;
    const detail = a.body.error ?? a.body.detail ?? a.body.reason;
    throw problem(
      typeof a.body.code === 'string' ? a.body.code : 'action_data_refused',
      a.status,
      typeof detail === 'string' ? detail : `The data API answered ${a.status}.`,
      a.body.errors,
    );
  };
  return {
    read: async (collection, id) => {
      declared('reads', collection);
      const a = await io.read(collection, id);
      if (a.status === 404) return null;
      const record = ok(a);
      await reveal(collection, [record]);
      return record;
    },
    list: async (collection, query) => {
      declared('reads', collection);
      const body = ok(await io.list(collection, query));
      // An `as_of` page is history, which holds no secret: only live rows get one.
      if (Array.isArray(body.records) && body.time_travel === undefined) {
        await reveal(collection, body.records as Record<string, unknown>[]);
      }
      return body;
    },
    insert: async (collection, data) => {
      declared('writes', collection);
      return ok(await io.create(collection, data));
    },
    update: async (collection, id, data, options) => {
      declared('writes', collection);
      return ok(await io.update(collection, id, data, options?.expect));
    },
    delete: async (collection, id) => {
      declared('writes', collection);
      ok(await io.delete(collection, id));
    },
  };
}

/**
 * ADR 0025: what a route's `host.collections` reaches — the collections the
 * manifest declares (`collections`, read and written), and those its actions
 * and jobs list in `reads` / `writes`. Not `"*"` (ADR 0047): an action reaches
 * any collection only as its caller, and a route may act as the system
 * (`asSystem`), so the wildcard does not widen a route; `routeHost` also
 * passes no `anyCollection`.
 */
export function routeCollections(
  manifest: Pick<ExtensionManifest, 'collections' | 'actions' | 'jobs'> | null,
): { reads: ReadonlySet<string>; writes: ReadonlySet<string> } {
  const declared = manifest?.collections ?? [];
  const entries = [...(manifest?.actions ?? []), ...(manifest?.jobs ?? [])];
  const listed = (kind: 'reads' | 'writes') =>
    new Set([...declared, ...entries.flatMap((e) => e[kind]).filter((c) => c !== '*')]);
  return { reads: listed('reads'), writes: listed('writes') };
}

/**
 * ADR 0025: `host` for one of `extName`'s routes, serving request `c`. The data
 * API as the caller — the gate's principal, or `public` on one of its public
 * routes (ADR 0020) — except for the collections named by the
 * `ctx.internals.asSystem` calls open around the call: those go as the
 * extension's principal (ADR 0022's key, holding only them), on the request's
 * transaction. The owner reveal (ADR 0024) is the same for either.
 */
export function routeHost(
  c: unknown,
  extName: string,
  def: { reads: ReadonlySet<string>; writes: ReadonlySet<string> },
  internals: ExtensionInternals,
): RouteHost {
  // Through the extension's own gated `ctx.internals`: `data:write` for writes,
  // the public role on its public routes, no action mark on what it writes.
  const caller: DataIo = {
    read: (collection, id) => internals.readRecord(c, collection, id),
    list: (collection, query) => internals.listRecords(c, collection, query),
    create: (collection, data) => internals.createRecord(c, collection, data),
    update: (collection, id, data, expect) =>
      internals.updateRecord(c, collection, id, data, { expect }),
    delete: (collection, id) => internals.deleteRecord(c, collection, id),
  };
  const request = () => {
    const p = gatePrincipal(c);
    if (p) return { trx: p.trx, tenantId: p.tenantId, author: rowAuthorId(p.user), caller: p.user };
    const pub = publicRouteRequest(c);
    return pub?.extName === extName
      ? { trx: pub.trx, tenantId: pub.tenantId, author: null, caller: undefined }
      : undefined;
  };
  const io = (collection: string): DataIo => {
    const r = request();
    const named = r?.trx ? systemCollectionsFor(`ext:${extName}`, r.trx) : [];
    if (!r?.trx || !named.includes(collection)) return caller;
    const { trx, tenantId } = r;
    // `asSystem` itself is gated; asked again in case approval was withdrawn since.
    if (!holdsCapability(extName, 'data:system')) {
      throw new CapabilityDeniedError(extName, 'data:system', 'asSystem');
    }
    if (!tenantId || getCurrentTenantTrx() !== trx) {
      throw new Error(`route of "${extName}": asSystem acts only in its request's transaction`);
    }
    const user = extensionPrincipal(
      // Not a job name (`[a-z][a-zA-Z0-9]*`), so no job's principal is this one.
      `apikey:job:${extName}:@route`,
      `${extName} route as system`,
      {
        reads: named.filter((n) => def.reads.has(n)),
        writes: named.filter((n) => def.writes.has(n)),
      },
      r.author,
    );
    const grants = encodeApiKeyScopes(user.scopes);
    // Published on the request's transaction for the call, the caller's put back after.
    // A row rule resolves it to its author, the caller's (ADR 0028): `getRlsFilters`
    // does so from `authorUserId`, the database from `rowActor`.
    const as = async <T>(fn: () => Promise<T>) =>
      asIdentityOn(
        trx,
        {
          userId: user.id,
          email: '',
          role: 'api_key',
          roles: ['api_key'],
          bypass: false,
          collectionGrants: grants.grants,
          collectionAll: grants.all,
          rowActor: await rowActor(r.caller ?? user),
          // And the author's own row rules, as `getRlsFilters` ANDs them on.
          issuer: issuerRowIdentity(await keyIssuerRowActor(user)),
        },
        fn,
      );
    const data = jobData(user, trx, tenantId, undefined);
    return {
      read: (collection, id) => as(() => data.read(collection, id)),
      list: (collection, query) => as(() => data.list(collection, query)),
      create: (collection, body) => as(() => data.create(collection, body)),
      update: (collection, id, body, expect) => as(() => data.update(collection, id, body, expect)),
      delete: (collection, id) => as(() => data.delete(collection, id)),
    };
  };
  return {
    collections: hostCollections(
      `a route of "${extName}"`,
      def,
      {
        read: (collection, id) => io(collection).read(collection, id),
        list: (collection, query) => io(collection).list(collection, query),
        create: (collection, data) => io(collection).create(collection, data),
        update: (collection, id, data, expect) =>
          io(collection).update(collection, id, data, expect),
        delete: (collection, id) => io(collection).delete(collection, id),
      },
      async (collection, records) => {
        const r = request();
        if (r?.trx) await secretReveal(r.trx, r.tenantId, extName)(collection, records);
      },
    ),
    // ADR 0034: always as the caller, `asSystem` or not; none on a public route.
    files: callerFiles(c, extName),
  };
}
