/**
 * Which requests change the system's configuration (ADR 0006): the one list
 * `config-step-up.ts` enforces. Pure, so clients outside the engine (test
 * helpers, the bench) can name the same requests without loading the engine.
 */
const CONFIG_PREFIXES = [
  '/api/admin', // incl. /api/admin/rls, /api/admin/schema
  '/api/api-keys',
  '/api/backup',
  '/api/collections',
  '/api/edge-functions', // deploying code and approving what it may reach
  '/api/flows',
  '/api/marketplace',
  '/api/permissions',
  '/api/relations',
  '/api/settings',
  '/api/tenants',
  '/api/users',
  '/api/validation', // rules refuse every tenant's writes
  '/api/webhooks',
];

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Can a request with this method change anything (not GET, HEAD or OPTIONS)? */
export function mutates(method: string): boolean {
  return !SAFE.has(method.toUpperCase());
}

/**
 * Does `method path` change the system's configuration? An extension request is
 * classified by its permission check instead (`fenceAdminGrant`,
 * extension-auth-gate.ts): it is configuration when it mutates and is
 * authorized against the `admin` object.
 */
export function isConfigMutation(method: string, path: string): boolean {
  if (!mutates(method)) return false;
  if (path === '/api/permissions/bootstrap') return false;
  // `/api/rpc/:fn` calls a function (data); the registry of callable functions is configuration.
  if (path === '/api/rpc') return true;
  if (path.startsWith('/api/rpc/')) return method.toUpperCase() !== 'POST';
  return CONFIG_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}
