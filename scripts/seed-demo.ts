#!/usr/bin/env bun
/**
 * seed-demo.ts — turn a fresh engine into a populated, demo-ready instance in one
 * command. Installs every builtin business template and seeds its starter data, so
 * a `demo.zveltio.com` (or a local POC) shows working CRM / Invoicing / Projects /
 * Helpdesk / Inventory apps with real-looking rows instead of empty tables.
 *
 * Pairs with DEMO_MODE=true (middleware/demo-mode.ts), which lets visitors click
 * around safely. Idempotent: re-running skips collections/rows that already exist.
 *
 * Usage:
 *   BASE_URL=https://demo.zveltio.com \
 *   DEMO_ADMIN_EMAIL=admin@zveltio.com DEMO_ADMIN_PASSWORD=… \
 *   bun scripts/seed-demo.ts
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.DEMO_ADMIN_EMAIL ?? process.env.TEST_EMAIL ?? 'admin@zveltio.com';
const PASS = process.env.DEMO_ADMIN_PASSWORD ?? process.env.TEST_PASS ?? 'Test12345';

async function signIn(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!cookie) throw new Error(`sign-in failed (${res.status}) — check DEMO_ADMIN_* creds`);
  return cookie;
}

async function jobDone(cookie: string, jobId: string): Promise<boolean> {
  const r = await fetch(`${BASE}/api/collections/jobs/${jobId}`, { headers: { Cookie: cookie } });
  const j = (await r.json().catch(() => ({}))) as any;
  const status = j?.job?.status;
  if (status === 'failed') throw new Error(`DDL job ${jobId} failed: ${j?.job?.error ?? '?'}`);
  return status === 'completed';
}

async function pollJobs(cookie: string, jobIds: string[], timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(jobIds);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const id of [...pending]) {
      if (await jobDone(cookie, id).catch(() => false)) pending.delete(id);
    }
    if (pending.size > 0) await Bun.sleep(500);
  }
  if (pending.size > 0)
    throw new Error(`${pending.size} collection job(s) did not complete in time`);
}

const cookie = await signIn();
const headers = { Cookie: cookie, 'Content-Type': 'application/json' };

// Discover the builtin templates from the running engine (so this stays in sync
// with whatever the engine ships, no hardcoded list).
const listRes = await fetch(`${BASE}/api/templates`, { headers });
const { templates } = (await listRes.json()) as { templates: Array<{ id: string; name: string }> };
if (!templates?.length) throw new Error('engine returned no templates');

let totalCollections = 0;
let totalRows = 0;
const report: string[] = [];

for (const t of templates) {
  // 1. Install (creates collections via the async DDL queue).
  const insRes = await fetch(`${BASE}/api/templates/${encodeURIComponent(t.id)}/install`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const ins = (await insRes.json().catch(() => ({}))) as any;
  if (!ins?.installed) {
    report.push(`✗ ${t.id}: install failed — ${ins?.error ?? insRes.status}`);
    continue;
  }
  const jobIds = (ins.installed as any[]).filter((i) => i.job_id).map((i) => i.job_id as string);

  // 2. Wait for the collections to exist.
  try {
    await pollJobs(cookie, jobIds);
  } catch (e) {
    report.push(`✗ ${t.id}: ${(e as Error).message}`);
    continue;
  }

  // 3. Seed starter rows (retry once: 425 means a table wasn't ready yet).
  let seeded = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const seedRes = await fetch(`${BASE}/api/templates/${encodeURIComponent(t.id)}/seed`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const s = (await seedRes.json().catch(() => ({}))) as any;
    seeded = s?.seeded ?? 0;
    if (seedRes.status !== 425) break;
    await Bun.sleep(1000);
  }

  totalCollections += (ins.installed as any[]).length;
  totalRows += seeded;
  report.push(`✓ ${t.id}: ${(ins.installed as any[]).length} collections, ${seeded} sample rows`);
}

console.log('\n=== Demo seed ===');
for (const line of report) console.log(`  ${line}`);
console.log(
  `\nDemo ready: ${templates.length} apps, ${totalCollections} collections, ${totalRows} rows.`,
);

const failed = report.filter((l) => l.startsWith('✗')).length;
process.exit(failed > 0 ? 1 : 0);
