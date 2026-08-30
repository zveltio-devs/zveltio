#!/usr/bin/env bun
/**
 * Which routes need TWO database connections at once?
 *
 * The concurrency ceiling of an instance sits exactly at `DB_POOL_MAX`, and it
 * is not a slope: at `c = pool` the service stops, with every connection
 * `idle in transaction` and one active. The plan blamed transaction LENGTH —
 * a request holds its tenant transaction for its whole duration, so shorten it
 * and the ceiling lifts.
 *
 * Measured, that is not the mechanism. A warm list request holds its
 * transaction for 1,59 ms, of which 0,39 ms is before the first query and
 * 0,05 ms after the last. There is almost nothing at the edges to trim.
 *
 * The mechanism is a SECOND RESERVATION. A single request, against a pool of
 * one, hangs for ever:
 *
 *   DB_POOL_MAX=1  GET /api/data/<collection>   → no reply, 8,85 s, killed
 *   DB_POOL_MAX=2  GET /api/data/<collection>   → 200 in 62 ms
 *
 * The request holds one connection for the tenant transaction and then asks the
 * pool for another — `checkAccess`, `getColumnAccess`, `DDLManager.getCollection`
 * and friends take `db`, the pool, not the request's transaction, because inside
 * the transaction the session runs as `zveltio_rls` and cannot read what they
 * need. That is also exactly why the collapse point is `c = pool` rather than
 * `c = pool / 2`: below it some connection is always free to serve the second
 * ask, and at it every connection is held by a transaction whose owner is
 * waiting for a second that can never come.
 *
 * So this script asks each route the only question that matters, in the only
 * way that cannot be argued with: **can you answer at all with one connection?**
 *
 * It is a ratchet, not a pass/fail — nine of the twelve routes first probed
 * cannot, and pretending otherwise would just be a red build. The baseline
 * records who is already broken; the gate is that the list must not grow.
 *
 *   bun run scripts/check-second-reservation.ts
 *   bun run scripts/check-second-reservation.ts --update   # rewrite baseline
 *
 * Needs a migrated database in TEST_DATABASE_URL (or DATABASE_URL).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'quality-gates', 'second-reservation.json');
const UPDATE = process.argv.includes('--update');

/** Routes worth asking. GET only: a probe must not change anything. */
const ROUTES = [
  '/api/health',
  '/api/collections',
  '/api/me',
  '/api/webhooks',
  '/api/saved-queries',
  '/api/notifications',
  '/api/revisions',
  '/api/flows',
  '/api/dashboards',
  '/api/settings',
  '/api/users',
  '/api/api-keys',
  '/api/tenants',
  '/api/audit',
];

interface Baseline {
  note: string;
  /** Routes known to need a second connection. The list may shrink, never grow. */
  needsTwo: string[];
}

const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[second-reservation] no TEST_DATABASE_URL / DATABASE_URL — nothing to probe.');
  process.exit(2);
}

const PORT = Number(process.env.SECOND_RESERVATION_PORT ?? 3477);
const BASE = `http://127.0.0.1:${PORT}`;

const engine = spawn('bun', [join(ROOT, 'packages/engine/src/index.ts')], {
  env: {
    ...process.env,
    DATABASE_URL: dbUrl,
    PORT: String(PORT),
    // The whole point. One connection: any request that needs a second cannot
    // finish, and says so by not answering.
    DB_POOL_MAX: '1',
    ZVELTIO_REGISTRATION_ENABLED: '1',
    // Never let a probe reach the real registry — a 5 s fetch would read as a
    // hang and blame the wrong thing.
    REGISTRY_URL: process.env.REGISTRY_URL ?? 'http://127.0.0.1:9',
    // Supplied rather than inherited: under NODE_ENV=test the engine refuses to
    // boot without it, and a probe that cannot start would read as "every route
    // is broken" — the loudest possible false positive.
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ?? 'second-reservation-probe-secret-not-for-production',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let engineLog = '';
engine.stdout?.on('data', (d) => {
  engineLog += String(d);
});
engine.stderr?.on('data', (d) => {
  engineLog += String(d);
});

async function waitForBoot(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  return false;
}

/** A cookie for a god session, so a probe is not measuring the auth gate. */
async function godCookie(): Promise<string> {
  const email = `second-reservation-${Date.now()}@test.local`;
  const password = 'ProbeUser123!';
  await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Probe' }),
  }).catch(() => null);

  const { createDb } = await import('../packages/engine/src/db/index.js');
  const { sql } = await import('kysely');
  const db = createDb(dbUrl as string);
  try {
    await sql`UPDATE "user" SET role = 'god' WHERE email = ${email}`.execute(db);
  } finally {
    await db.destroy().catch(() => {});
  }

  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return (signIn.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

/** True when the route answered at all. A hang is the finding. */
async function answers(path: string, cookie: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(6000),
    });
    // Any status is an answer: 401/403/404 mean the route replied, which is all
    // this asks. Only silence means it could not get its second connection.
    return res.status > 0;
  } catch {
    return false;
  }
}

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE)) return null;
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
}

try {
  if (!(await waitForBoot())) {
    console.error('[second-reservation] engine did not boot:\n', engineLog.slice(-2000));
    process.exit(2);
  }
  const cookie = await godCookie();

  const needsTwo: string[] = [];
  for (const route of ROUTES) {
    const ok = await answers(route, cookie);
    if (!ok) needsTwo.push(route);
    console.log(`  ${ok ? '✅' : '❌'} ${route}`);
  }

  if (UPDATE) {
    const baseline: Baseline = {
      note:
        'Routes that cannot answer with DB_POOL_MAX=1, because they hold the tenant ' +
        'transaction and then ask the pool for a second connection. The list may SHRINK, ' +
        'never grow. See the header of scripts/check-second-reservation.ts for the ' +
        'measurement that produced it.',
      needsTwo,
    };
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\n[second-reservation] baseline written (${needsTwo.length} route(s)).`);
    process.exit(0);
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error(
      '\n[second-reservation] no baseline. Create it with:\n' +
        '  bun run scripts/check-second-reservation.ts --update',
    );
    process.exit(2);
  }

  const known = new Set(baseline.needsTwo);
  const added = needsTwo.filter((r) => !known.has(r));
  const fixed = baseline.needsTwo.filter((r) => !needsTwo.includes(r));

  if (fixed.length > 0) {
    console.log(
      `\n[second-reservation] ${fixed.length} route(s) no longer need two: ${fixed.join(', ')}`,
    );
    console.log('Run with --update to record the improvement.');
  }
  if (added.length > 0) {
    console.error(
      `\n❌ second-reservation: ${added.length} NEW route(s) cannot answer on one connection:\n` +
        added.map((r) => `   - ${r}`).join('\n') +
        '\n\nA route that holds the tenant transaction must not then ask the pool for a\n' +
        'second connection: at c = DB_POOL_MAX every connection is held and the second\n' +
        'can never arrive, so the instance stops rather than slows.',
    );
    process.exit(1);
  }
  console.log(`\n✅ second-reservation: no new routes (${needsTwo.length} known).`);
} finally {
  engine.kill('SIGTERM');
}
