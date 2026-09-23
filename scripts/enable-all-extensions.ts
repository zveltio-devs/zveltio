#!/usr/bin/env bun
/** Enable all catalog extensions on live engine and report outcomes. */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.TEST_EMAIL ?? 'admin@zveltio.com';
const PASS = process.env.TEST_PASS ?? 'Test12345';

const signRes = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASS }),
});
const cookie = signRes.headers.get('set-cookie')?.split(';')[0] ?? '';
if (!cookie) throw new Error(`sign-in failed (${signRes.status}) — check TEST_EMAIL/TEST_PASS`);
const headers = { Cookie: cookie, 'Content-Type': 'application/json' };

// The catalogue, not `/api/extensions`. That route lists what is already ACTIVE,
// so this script used to re-enable what was on and never touch the rest — on a
// fresh engine it enabled 0 extensions and exited 0.
const extRes = await fetch(`${BASE}/api/marketplace`, { headers });
if (!extRes.ok) throw new Error(`GET /api/marketplace answered ${extRes.status}`);
const { extensions } = (await extRes.json()) as {
  extensions: { name: string; category?: string }[];
};
// `fixture` entries are the release job's smoke extensions, never in the registry;
// the Studio marketplace hides them for the same reason.
const names = extensions
  .filter((e) => e.category !== 'fixture')
  .map((e) => e.name)
  .sort();
if (names.length === 0) throw new Error('the marketplace lists no extensions');

type Result = { name: string; ok: boolean; hot: boolean; err: string };
async function enable(name: string): Promise<Result> {
  const res = await fetch(`${BASE}/api/marketplace/${encodeURIComponent(name)}/enable`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const body = await res.json().catch(() => ({}));
  return {
    name,
    ok: !!body.success,
    hot: !!body.hot_loaded,
    err:
      body.detail ??
      body.error_detail ??
      body.message ??
      (body.success ? '' : JSON.stringify(body)),
  };
}

// Alphabetical order reaches an extension before the one it requires, which
// refuses it. Retry the refusals until a pass enables nothing new.
const results: Result[] = [];
let queue = names;
while (queue.length > 0) {
  const pass = [];
  for (const name of queue) pass.push(await enable(name));
  results.push(...pass.filter((r) => r.ok));
  const refused = pass.filter((r) => !r.ok);
  if (refused.length === queue.length) {
    results.push(...refused);
    break;
  }
  queue = refused.map((r) => r.name);
}

const ok = results.filter((r) => r.ok);
const fail = results.filter((r) => !r.ok);
const noHot = results.filter((r) => r.ok && !r.hot);

console.log(`\n=== ENABLE ALL ${names.length} EXTENSIONS ===`);
console.log(
  `success: ${ok.length} | failed: ${fail.length} | success-but-not-hot: ${noHot.length}`,
);

if (fail.length) {
  console.log('\n--- FAILURES ---');
  for (const r of fail) console.log(`  ${r.name}: ${r.err.slice(0, 120)}`);
}
if (noHot.length) {
  console.log('\n--- NOT HOT-LOADED (but success) ---');
  for (const r of noHot) console.log(`  ${r.name}: ${r.err.slice(0, 120)}`);
}

process.exit(fail.length > 0 ? 1 : 0);
