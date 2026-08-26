#!/usr/bin/env bun
/**
 * A router built on `poolDb` must not run inside the request transaction.
 *
 * Why this is a gate and not a comment: the failure it prevents is a total
 * standstill, and it is invisible until the exact moment concurrency reaches
 * the pool size.
 *
 * The mechanism. `tenantMiddleware` opens a transaction for the request, which
 * RESERVES one pooled connection for its whole life. A handler that then runs
 * on `poolDb` needs a SECOND connection. At a concurrency equal to
 * `DB_POOL_MAX`, every in-flight request is holding one connection and waiting
 * for another, and none of them can release. Measured on `/api/insights/dashboards`
 * with `DB_POOL_MAX=10`:
 *
 *     c=5   →     10ms p50,  0 failures,  530 req/s
 *     c=10  →  12000ms p50, 55 of 60 failed, 1 req/s
 *
 * with `pg_stat_activity` showing ten connections `idle in transaction` and
 * zero `active`. After adding the four routers to `TXN_SKIP_PREFIXES`, the same
 * route is flat to c=50 (52ms p50, no failures).
 *
 * What it does NOT check: whether skipping is SAFE for a given router. That is
 * a judgement about whether the router relies on the tenant GUC, and it is
 * recorded next to each entry in `TXN_SKIP_PREFIXES`. This gate only refuses
 * the combination that deadlocks — on the pool, and inside the transaction.
 *
 * `poolDb` passed as a LATER argument is deliberately not flagged.
 * `usersRoutes(db, auth, poolDb)` runs on the request transaction and reaches
 * for the pool on exactly one cold path (revoking sessions on delete). Skipping
 * that router would drop RLS across all of it to spare one call.
 */

const ROUTES = 'packages/engine/src/routes/index.ts';
const MIDDLEWARE = 'packages/engine/src/middleware/tenant.ts';

const routesSrc = await Bun.file(ROUTES).text();
const middlewareSrc = await Bun.file(MIDDLEWARE).text();

// `TXN_SKIP_PREFIXES = [ ... ]` — read the real list rather than a copy of it,
// so this cannot drift from what the middleware actually applies.
const listMatch = middlewareSrc.match(/TXN_SKIP_PREFIXES\s*=\s*\[([\s\S]*?)\n\];/);
if (!listMatch) {
  console.error(`[pooldb-txn-skip] could not find TXN_SKIP_PREFIXES in ${MIDDLEWARE}`);
  process.exit(1);
}
const skipPrefixes = [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

// `app.route('<path>', <name>(poolDb, …))` — poolDb as the FIRST argument, which
// is what "this router runs on the pool" looks like.
const mounted = [...routesSrc.matchAll(/app\.route\(\s*'([^']+)'\s*,\s*(\w+)\(\s*poolDb\b/g)].map(
  (m) => ({ path: m[1], router: m[2] }),
);

if (mounted.length === 0) {
  // Not "nothing to check": the pattern is how this gate sees anything at all.
  // If a refactor changes how routers are mounted, silence here would read as
  // a pass forever.
  console.error(
    `[pooldb-txn-skip] found no \`app.route('…', x(poolDb…))\` in ${ROUTES}.\n` +
      `That is either a refactor of how routers mount, or this gate has gone blind.\n` +
      `Update the pattern rather than deleting the check.`,
  );
  process.exit(1);
}

const covered = (path: string): boolean => skipPrefixes.some((p) => path.startsWith(p));
const offenders = mounted.filter((m) => !covered(m.path));

if (offenders.length > 0) {
  console.error(
    `[pooldb-txn-skip] ${offenders.length} router(s) on the pool INSIDE the request transaction:\n`,
  );
  for (const o of offenders) {
    console.error(`   ${o.path}  →  ${o.router}(poolDb, …)`);
  }
  console.error(
    `\nEach of these reserves a connection for the request transaction and then asks\n` +
      `the pool for a second one. At a concurrency equal to DB_POOL_MAX that is a\n` +
      `standstill, not a slowdown: every request holds one and waits for one.\n\n` +
      `Fix by adding the path to TXN_SKIP_PREFIXES in ${MIDDLEWARE} — but first\n` +
      `check the router does not read \`tenantTrx\` or rely on the tenant GUC. If it\n` +
      `does, it should take \`db\` rather than \`poolDb\`, and the fix is there.`,
  );
  process.exit(1);
}

console.log(
  `[pooldb-txn-skip] OK — ${mounted.length} pool-backed router(s), all outside the request transaction ` +
    `(${mounted.map((m) => m.path).join(', ')}).`,
);
