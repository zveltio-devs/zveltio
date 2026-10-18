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
  ZveltioExtension,
} from '@zveltio/sdk/extension';
import { getDb } from '../../db/index.js';
import { auditLog } from '../audit.js';
import { problem } from '../problem.js';
import { gatePrincipal } from '../../middleware/extension-auth-gate.js';
import { afterRequestSettles } from '../../middleware/tenant.js';
import type { ExtensionManifest } from './manifest-schema.js';
import type { ExtensionContext, ExtensionInternals } from './internals.js';
import { enqueueJob } from './jobs.js';

export interface CompiledAction {
  name: string;
  permission: { resource: string; action: string };
  input: z.ZodType;
  reads: ReadonlySet<string>;
  writes: ReadonlySet<string>;
  /** The jobs `ActionHost.enqueue` may queue. */
  enqueues: ReadonlySet<string>;
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
    try {
      const input = z.fromJSONSchema(d.input as Parameters<typeof z.fromJSONSchema>[0]);
      return { declared: d, input, run: run as F };
    } catch (err) {
      return refuse(
        `${kind} "${d.name}": input is not a usable JSON Schema (${(err as Error).message})`,
      );
    }
  });
  for (const name of Object.keys(implemented)) {
    if (!declared.some((d) => d.name === name)) {
      refuse(`${kind} "${name}" is implemented but not declared in the manifest`);
    }
  }
  return out;
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
      reads: new Set(a.reads),
      writes: new Set(a.writes),
      enqueues: new Set(a.enqueues),
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
  if (actions.size === 0) return;
  sub.post('/actions/:name', async (c) => {
    const def = actions.get(c.req.param('name'));
    if (!def) return c.json({ error: 'Not found' }, 404);
    // Who the gate admitted, recorded before any extension code ran — never `c.get('user')`.
    const p = gatePrincipal(c);
    if (!p) return c.json({ error: 'Unauthorized', code: 'EXT_AUTH_REQUIRED' }, 401);
    // Without the request transaction each write would commit on its own, and a
    // throw half-way would keep the first half.
    if (!p.trx) throw new Error(`action ${extName}/${def.name}: this request holds no transaction`);
    const { resource, action } = def.permission;
    if (!(await ctx.checkPermission(p.user.id, resource, action))) {
      return c.json({ error: 'Forbidden', code: 'permission_required', resource, action }, 403);
    }
    const parsed = def.input.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    // After the transaction ends, on the pool: a failure rolls back the
    // request's own writes, and the row recording it must survive that.
    afterRequestSettles(c, () =>
      auditLog(getDb(), {
        type: 'extension.action.executed',
        userId: p.user.id,
        resourceType: 'extension_action',
        resourceId: `${extName}:${def.name}`,
        metadata: {
          extension: extName,
          action: def.name,
          outcome: c.res.status < 400 ? 'success' : 'failure',
          status: c.res.status,
        },
        tenantId: p.tenantId,
      }),
    );
    const host: ActionHost = {
      collections: hostCollections(`action "${def.name}"`, def, callerData(c, ctx.internals)),
      enqueue: (job, input) => enqueueJob(extName, p, def, job, input),
    };
    const result = await def.run(parsed.data, host);
    return c.json({ result: result ?? null });
  });
}

/** One data API call per member of `HostCollections`, answering with the route's status and body. */
export interface DataIo {
  read(collection: string, id: string): Promise<DataApiAnswer>;
  list(collection: string, query?: DataApiReadQuery): Promise<DataApiAnswer>;
  create(collection: string, data: Record<string, unknown>): Promise<DataApiAnswer>;
  update(collection: string, id: string, data: Record<string, unknown>): Promise<DataApiAnswer>;
  delete(collection: string, id: string): Promise<DataApiAnswer>;
}

/** The data API as the request's caller. */
function callerData(c: Context, internals: ExtensionInternals): DataIo {
  return {
    read: (collection, id) => internals.readRecord(c, collection, id),
    list: (collection, query) => internals.listRecords(c, collection, query),
    create: (collection, data) => internals.createRecord(c, collection, data),
    update: (collection, id, data) => internals.updateRecord(c, collection, id, data),
    delete: (collection, id) => internals.deleteRecord(c, collection, id),
  };
}

/** `io`, narrowed to the collections `def` declares; a refused call throws. */
export function hostCollections(
  what: string,
  def: { reads: ReadonlySet<string>; writes: ReadonlySet<string> },
  io: DataIo,
): HostCollections {
  const declared = (kind: 'reads' | 'writes', collection: string) => {
    if (!def[kind].has(collection)) {
      throw new Error(
        `${what} reached collection "${collection}", which its manifest does not list in ${kind}`,
      );
    }
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
      return a.status === 404 ? null : ok(a);
    },
    list: async (collection, query) => {
      declared('reads', collection);
      return ok(await io.list(collection, query));
    },
    insert: async (collection, data) => {
      declared('writes', collection);
      return ok(await io.create(collection, data));
    },
    update: async (collection, id, data) => {
      declared('writes', collection);
      return ok(await io.update(collection, id, data));
    },
    delete: async (collection, id) => {
      declared('writes', collection);
      ok(await io.delete(collection, id));
    },
  };
}
