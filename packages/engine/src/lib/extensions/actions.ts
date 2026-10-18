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
  ExtensionAction,
  ZveltioExtension,
} from '@zveltio/sdk/extension';
import { getDb } from '../../db/index.js';
import { auditLog } from '../audit.js';
import { problem } from '../problem.js';
import { gatePrincipal } from '../../middleware/extension-auth-gate.js';
import { afterRequestSettles } from '../../middleware/tenant.js';
import type { ExtensionManifest } from './manifest-schema.js';
import type { ExtensionContext, ExtensionInternals } from './internals.js';

export interface CompiledAction {
  name: string;
  permission: { resource: string; action: string };
  input: z.ZodType;
  reads: ReadonlySet<string>;
  writes: ReadonlySet<string>;
  run: ExtensionAction;
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
  const refuse = (why: string) => {
    throw new Error(`Extension "${extName}": ${why}`);
  };
  if (worker) refuse('actions are not served for a worker-isolated extension yet');
  if (extension.mountStrategy !== 'subapp') refuse("actions need mountStrategy 'subapp'");
  for (const a of declared) {
    const run = Object.hasOwn(implemented, a.name) ? implemented[a.name] : undefined;
    if (typeof run !== 'function') refuse(`manifest action "${a.name}" has no implementation`);
    let input: z.ZodType;
    try {
      input = z.fromJSONSchema(a.input as Parameters<typeof z.fromJSONSchema>[0]);
    } catch (err) {
      return refuse(
        `action "${a.name}": input is not a usable JSON Schema (${(err as Error).message})`,
      );
    }
    out.set(a.name, {
      name: a.name,
      permission: a.permission,
      input,
      reads: new Set(a.reads),
      writes: new Set(a.writes),
      run: run as ExtensionAction,
    });
  }
  for (const name of Object.keys(implemented)) {
    if (!out.has(name)) refuse(`action "${name}" is implemented but not declared in the manifest`);
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
    const result = await def.run(parsed.data, actionHost(c, def, ctx.internals));
    return c.json({ result: result ?? null });
  });
}

/** The data API as the request's caller, narrowed to what the action declares. */
function actionHost(c: Context, def: CompiledAction, internals: ExtensionInternals): ActionHost {
  const declared = (kind: 'reads' | 'writes', collection: string) => {
    if (!def[kind].has(collection)) {
      throw new Error(
        `action "${def.name}" reached collection "${collection}", which its manifest does not ` +
          `list in ${kind}`,
      );
    }
  };
  // A refused write fails the action, so the request rolls back what it wrote before.
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
    collections: {
      read: async (collection, id) => {
        declared('reads', collection);
        const a = await internals.readRecord(c, collection, id);
        return a.status === 404 ? null : ok(a);
      },
      list: async (collection, query) => {
        declared('reads', collection);
        return ok(await internals.listRecords(c, collection, query));
      },
      insert: async (collection, data) => {
        declared('writes', collection);
        return ok(await internals.createRecord(c, collection, data));
      },
      update: async (collection, id, data) => {
        declared('writes', collection);
        return ok(await internals.updateRecord(c, collection, id, data));
      },
      delete: async (collection, id) => {
        declared('writes', collection);
        ok(await internals.deleteRecord(c, collection, id));
      },
    },
  };
}
