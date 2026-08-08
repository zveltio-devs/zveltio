/**
 * `permissionGate` — minimal route-level RBAC for extensions.
 *
 * Default-deny: if no Casbin policy grants the resource/action, the request
 * is rejected with 403. The god role bypasses the gate (handled by the
 * engine's `checkPermission`).
 *
 * Action is derived from the HTTP method using the standard CRUD mapping
 * (GET → read, POST → create, PATCH/PUT → update, DELETE → delete). The
 * `resource` is the extension's logical name (e.g. `'crm'`, `'invoices'`);
 * operators grant access by adding a Casbin policy:
 *
 *     INSERT INTO zvd_permissions (ptype, v0, v1, v2)
 *     VALUES ('p', 'user_role', 'crm', 'read');
 *
 * Why this exists: many extensions historically only checked
 * `auth.api.getSession(...)` — i.e. any authenticated user could
 * read/write the entire extension. That's the right default for a
 * single-tenant deployment but unacceptable in multi-tenant or
 * role-segmented installs. The gate gives operators a single knob to
 * tighten access without each extension having to roll its own RBAC.
 *
 * Usage in an extension's `routes.ts`:
 *
 *     app.use('*', permissionGate(ctx, 'crm'));
 *
 * Place AFTER the auth-guard middleware that sets `c.set('user', ...)`.
 */

type MaybePromise<T> = T | Promise<T>;

interface Granter {
  name: string;
}

interface DenialContext {
  resource: string;
  action: string;
  confidential: boolean;
  canGrant: Granter[];
}

interface GateContext {
  checkPermission: (userId: string, resource: string, action: string) => Promise<boolean>;
  /**
   * Supplied by the host so a refusal can say who to ask. Optional because an
   * extension may be running against an engine older than this, and a missing
   * courtesy must never become a missing refusal.
   */
  describeDenial?: (resource: string, action: string) => Promise<DenialContext>;
}

/**
 * Turn a refusal into a next step.
 *
 * `Forbidden: missing payroll:read permission` is what this used to answer:
 * English on a Romanian product, naming an internal concept, to someone from HR
 * who opened a page. It says what is absent and nothing about what to do, so
 * the reader cannot tell a rule from a bug.
 *
 * The information that fixes it is already in the database — somebody here
 * holds an administrative role — and the host hands it over through
 * `describeDenial`. What comes back is data, not a sentence, so the Studio can
 * draw a screen and translate it; the English `detail` below is for logs, curl,
 * and anything that has nowhere to put structure.
 *
 * `code` stays machine-stable at `permission_required`, because callers should
 * branch on that rather than on prose.
 */
/** Just enough of a Hono context to answer with JSON. */
interface JsonResponder {
  json: (body: unknown, status: number) => unknown;
}

async function refuse(ctx: GateContext, c: JsonResponder, resource: string, action: string) {
  let denial: DenialContext | null = null;
  try {
    denial = (await ctx.describeDenial?.(resource, action)) ?? null;
  } catch {
    /* the refusal matters more than the suggestion */
  }

  const names = denial?.canGrant.map((g) => g.name) ?? [];
  const who =
    names.length === 0
      ? 'An administrator of this workspace'
      : names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  const what = denial?.confidential
    ? `${resource} is confidential`
    : `you do not have access to ${resource}`;
  const detail =
    names.length === 0 ? `${what}. ${who} can grant it.` : `${what}. ${who} can give you access.`;

  return c.json(
    {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      code: 'permission_required',
      detail,
      resource,
      action,
      confidential: denial?.confidential ?? false,
      can_grant: names.map((name) => ({ name })),
    },
    403,
  );
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

function methodToAction(method: string): string {
  const m = method.toUpperCase() as Method;
  switch (m) {
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
      return 'read';
    case 'POST':
      return 'create';
    case 'PATCH':
    case 'PUT':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      // Unknown method → demand the most restrictive action so the gate
      // never fails open.
      return 'delete';
  }
}

/**
 * Operators can disable the gate temporarily during a permission backfill
 * by setting `EXTENSION_RBAC=permissive`. When permissive, the gate becomes
 * a no-op (any authenticated user passes) but still logs the denied
 * attempts so the operator can preview what *would* have been blocked
 * before flipping to strict.
 *
 * Strict (default) is the secure posture and what the SDK ships with.
 */
function rbacMode(): 'strict' | 'permissive' {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const v = (globalThis as any).process?.env?.EXTENSION_RBAC;
  return v === 'permissive' ? 'permissive' : 'strict';
}

export function permissionGate(
  ctx: GateContext,
  resource: string,
  opts: { actionOverrides?: Record<string, string> } = {},
) {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  return async (c: any, next: () => MaybePromise<unknown>) => {
    // CORS preflight (OPTIONS) must never be authorization-gated —
    // browsers send it without credentials and a 401/403 here breaks
    // the actual cross-origin request that would follow. The global
    // CORS middleware in the engine returns the preflight response;
    // we just need to let it through.
    if (c.req.method === 'OPTIONS') {
      await next();
      return;
    }
    const user = c.get('user');
    if (!user?.id) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const methodKey = c.req.method.toUpperCase();
    const action = opts.actionOverrides?.[methodKey] ?? methodToAction(methodKey);
    const allowed = await ctx.checkPermission(user.id, resource, action);
    if (!allowed) {
      if (rbacMode() === 'permissive') {
        // Audit-log mode: surface what WOULD be blocked so operators can
        // configure policies before flipping to strict. Stays a single
        // console.warn — no DB writes on the hot path.
        console.warn(
          `[permissionGate] WOULD DENY user=${user.id} ${c.req.method} ${c.req.path} → ${resource}:${action} (EXTENSION_RBAC=permissive — gate bypassed)`,
        );
        await next();
        return;
      }
      return refuse(ctx, c, resource, action);
    }
    await next();
  };
}
