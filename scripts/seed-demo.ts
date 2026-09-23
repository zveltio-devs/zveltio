#!/usr/bin/env bun
/**
 * seed-demo.ts — turn a fresh engine into a populated, demo-ready instance in one
 * command. Installs every builtin business template and seeds its starter data, so
 * a `demo.zveltio.com` (or a local POC) shows working Invoicing / Projects /
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
  if (r.status === 429) {
    await Bun.sleep((Number(r.headers.get('retry-after')) || 5) * 1000);
    return false;
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const j = (await r.json().catch(() => ({}))) as any;
  const status = j?.job?.status;
  if (status === 'failed') throw new Error(`DDL job ${jobId} failed: ${j?.job?.error ?? '?'}`);
  return status === 'completed';
}

// The deadline is for a STALLED queue, not the whole install: jobs run one at a
// time, and ansvsa's 64 collections take several minutes, so a flat 90 s failed
// a queue that was working. Every finished job buys another window.
async function pollJobs(cookie: string, jobIds: string[], stallMs = 90_000): Promise<void> {
  let deadline = Date.now() + stallMs;
  const pending = new Set(jobIds);
  while (pending.size > 0 && Date.now() < deadline) {
    const before = pending.size;
    for (const id of [...pending]) {
      // No `.catch` here: it swallowed the throw for a FAILED job, so a failure
      // (`Collection 'crm_activities' already exists`) waited out the 90 s and
      // was reported as "did not complete in time".
      // The queue runs jobs in order, so the first unfinished one is where to
      // stop. Asking about all 64 of ansvsa's every half second tripped the rate
      // limiter, every answer became a 429, and a working queue looked stalled.
      if (!(await jobDone(cookie, id))) break;
      pending.delete(id);
    }
    if (pending.size < before) deadline = Date.now() + stallMs;
    if (pending.size > 0) await Bun.sleep(500);
  }
  if (pending.size > 0)
    throw new Error(`${pending.size} collection job(s) did not complete in time`);
}

/**
 * POST, waiting out a 429. Templates installed and seeded back to back trip
 * the write limiter, and the last two installs failed with a bare 429. The
 * limiter escalates on repeat offences, so the wait is the one it asks for.
 */
async function post(url: string, headers: Record<string, string>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers, body: '{}' });
    if (res.status !== 429 || attempt === 3) return res;
    const wait = Number(res.headers.get('retry-after')) || 5;
    console.log(`  … rate limited, waiting ${wait}s`);
    await Bun.sleep(wait * 1000);
  }
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
  const insRes = await post(`${BASE}/api/templates/${encodeURIComponent(t.id)}/install`, headers);
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const ins = (await insRes.json().catch(() => ({}))) as any;
  if (!ins?.installed) {
    report.push(`✗ ${t.id}: install failed — ${ins?.error ?? insRes.status}`);
    continue;
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const jobIds = (ins.installed as any[]).filter((i) => i.job_id).map((i) => i.job_id as string);

  // 2. Wait for the collections to exist.
  try {
    await pollJobs(cookie, jobIds);
  } catch (e) {
    report.push(`✗ ${t.id}: ${(e as Error).message}`);
    continue;
  }

  // 3. Seed starter rows (retry once: 425 means a table wasn't ready yet).
  // Each call reports only the rows IT inserted, so the attempts add up. Anything
  // but a 200 at the end — a 500, or a table still missing after the retry — is
  // a failed seed: it used to print ✓ with "0 sample rows" and exit 0.
  let seeded = 0;
  let seedStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const seedRes = await post(`${BASE}/api/templates/${encodeURIComponent(t.id)}/seed`, headers);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const s = (await seedRes.json().catch(() => ({}))) as any;
    seeded += s?.seeded ?? 0;
    seedStatus = seedRes.status;
    if (seedRes.status !== 425) break;
    await Bun.sleep(1000);
  }
  if (seedStatus !== 200) {
    report.push(`✗ ${t.id}: seed answered ${seedStatus} after ${seeded} rows`);
    continue;
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  totalCollections += (ins.installed as any[]).length;
  totalRows += seeded;
  report.push(
    `✓ ${t.id}: ${
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      (ins.installed as any[]).length
    } collections, ${seeded} sample rows`,
  );
}

console.log('\n=== Demo seed ===');
for (const line of report) console.log(`  ${line}`);
console.log(
  `\nDemo ready: ${templates.length} apps, ${totalCollections} collections, ${totalRows} rows.`,
);

const failed = report.filter((l) => l.startsWith('✗')).length;
process.exit(failed > 0 ? 1 : 0);
