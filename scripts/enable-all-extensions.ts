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
const headers = { Cookie: cookie, 'Content-Type': 'application/json' };

const extRes = await fetch(`${BASE}/api/extensions`, { headers });
const d = await extRes.json();
const names: string[] =
  Array.isArray(d.extensions) && typeof d.extensions[0] === 'string'
    ? d.extensions
    : // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      (d.extensions ?? d.meta ?? []).map((e: any) => e.name);

const results: { name: string; ok: boolean; hot: boolean; err: string }[] = [];

for (const name of names.sort()) {
  const res = await fetch(`${BASE}/api/marketplace/${encodeURIComponent(name)}/enable`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const body = await res.json().catch(() => ({}));
  results.push({
    name,
    ok: !!body.success,
    hot: !!body.hot_loaded,
    err: body.error_detail ?? body.message ?? (body.success ? '' : JSON.stringify(body)),
  });
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
