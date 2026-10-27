/**
 * Which requests change the system's configuration (ADR 0006): the one list
 * `config-step-up.ts` enforces. Pure, so clients outside the engine (test
 * helpers, the bench) can name the same requests without loading the engine.
 */
const CONFIG_PREFIXES = [
  '/api/admin', // incl. /api/admin/rls, /api/admin/sql, /api/admin/schema
  '/api/api-keys',
  '/api/backup',
  '/api/collections',
  '/api/flows',
  '/api/marketplace',
  '/api/permissions',
  '/api/relations',
  '/api/schema',
  '/api/settings',
  '/api/templates',
  '/api/tenants',
  '/api/users',
  '/api/webhooks',
];

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Does `method path` change the system's configuration? */
export function isConfigMutation(method: string, path: string): boolean {
  if (SAFE.has(method.toUpperCase())) return false;
  if (path === '/api/permissions/bootstrap') return false;
  // `/api/rpc/:fn` calls a function (data); the registry of callable functions is configuration.
  if (path === '/api/rpc') return true;
  if (path.startsWith('/api/rpc/')) return method.toUpperCase() !== 'POST';
  // Insights panels and the ad-hoc query run raw SQL on the global pool:
  // configuration. Running a saved panel, and saved queries (structured,
  // permission-checked through the masking view), are use.
  if (path === '/api/insights' || path.startsWith('/api/insights/')) {
    return !path.startsWith('/api/insights/saved-queries') && !path.endsWith('/execute');
  }
  return CONFIG_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}
