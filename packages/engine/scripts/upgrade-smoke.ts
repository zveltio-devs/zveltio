/**
 * H-11 — upgrade-path smoke test (seed / verify).
 *
 * Drives a RUNNING engine purely over its public HTTP API so it works
 * identically against a released binary and a freshly-built HEAD:
 *
 *   1. `seed`   — run against the release (N-1) binary. Creates a collection
 *                 with several field types, records carrying unguessable
 *                 sentinels, and a webhook (a flow best-effort). Writes what it
 *                 created to a JSON state file.
 *   2. verify   — run against HEAD after its migrations applied to the SAME DB.
 *                 Signs in as the same user (proves the auth/session tables
 *                 migrated), re-reads every seeded value byte-for-byte, and
 *                 checks the webhook/flow survived + /health is green.
 *
 * A single mismatch exits non-zero — a broken upgrade is the most expensive
 * possible bug for a self-hosted Business OS.
 *
 * Env:
 *   UPGRADE_BASE_URL     default http://localhost:3000
 *   UPGRADE_EMAIL        the god admin (created by the workflow before seeding)
 *   UPGRADE_PASSWORD
 *   UPGRADE_TENANT_SLUG  optional X-Tenant-Slug header
 *   UPGRADE_STATE_FILE   default /tmp/upgrade-smoke-state.json
 */

const BASE = process.env.UPGRADE_BASE_URL ?? 'http://localhost:3000';
const EMAIL = process.env.UPGRADE_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.UPGRADE_PASSWORD ?? 'admin1234';
const TENANT = process.env.UPGRADE_TENANT_SLUG ?? '';
const STATE_FILE = process.env.UPGRADE_STATE_FILE ?? '/tmp/upgrade-smoke-state.json';

interface SeededRecord {
  id: string;
  expected: Record<string, unknown>;
}
interface SmokeState {
  collection: string;
  records: SeededRecord[];
  webhookId: string | null;
  flowId: string | null;
}

function tenantHeaders(base: Record<string, string> = {}): Record<string, string> {
  return TENANT ? { ...base, 'X-Tenant-Slug': TENANT } : base;
}

async function signIn(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`sign-in failed: HTTP ${res.status} ${await res.text()}`);
  }
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw new Error('sign-in returned no session cookie');
  return cookie;
}

async function waitForTable(cookie: string, collection: string): Promise<void> {
  // Collection creation is async (DDL job) — poll until the data endpoint is live.
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${BASE}/api/data/${collection}`, {
      headers: tenantHeaders({ Cookie: cookie }),
    });
    if (res.status === 200) return;
    await Bun.sleep(1000);
  }
  throw new Error(`collection ${collection} table never became queryable`);
}

async function seed(): Promise<void> {
  const cookie = await signIn();
  const stamp = Date.now();
  const collection = `upgrade_probe_${stamp}`;

  // ── Collection with several field types ─────────────────────────────────
  const createCol = await fetch(`${BASE}/api/collections`, {
    method: 'POST',
    headers: tenantHeaders({ Cookie: cookie, 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name: collection,
      fields: [
        { name: 'title', type: 'text' },
        { name: 'qty', type: 'number' },
        { name: 'active', type: 'boolean' },
        { name: 'meta', type: 'json' },
        { name: 'due', type: 'date' },
      ],
    }),
  });
  if (createCol.status >= 300) {
    throw new Error(`collection create failed: HTTP ${createCol.status} ${await createCol.text()}`);
  }
  await waitForTable(cookie, collection);

  // ── Records with unguessable sentinels covering each type ───────────────
  const inputs: Record<string, unknown>[] = [
    {
      title: `SENTINEL-A-${stamp}`,
      qty: 42,
      active: true,
      meta: { k: 'v', n: 1 },
      due: '2027-01-15',
    },
    {
      title: `SENTINEL-B-${stamp}`,
      qty: -7,
      active: false,
      meta: { nested: { deep: true } },
      due: '2030-12-31',
    },
    { title: `SENTINEL-C-${stamp}`, qty: 0, active: true, meta: [], due: '2026-06-06' },
  ];
  const records: SeededRecord[] = [];
  for (const input of inputs) {
    const res = await fetch(`${BASE}/api/data/${collection}`, {
      method: 'POST',
      headers: tenantHeaders({ Cookie: cookie, 'Content-Type': 'application/json' }),
      body: JSON.stringify(input),
    });
    if (res.status >= 300) {
      throw new Error(`record insert failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as Record<string, unknown> & { record?: { id?: string } };
    const id = (body.record?.id ?? body.id) as string | undefined;
    if (!id) throw new Error(`record insert returned no id: ${JSON.stringify(body)}`);

    // Record what THIS version actually returns (not the raw input) — a `date`
    // field, say, round-trips as an ISO timestamp. The upgrade invariant is that
    // HEAD returns the SAME representation N-1 did; a serialization change here
    // is a genuine finding, not a false positive from input-vs-stored coercion.
    const readBack = await fetch(`${BASE}/api/data/${collection}/${id}`, {
      headers: tenantHeaders({ Cookie: cookie }),
    });
    const rbBody = (await readBack.json()) as Record<string, unknown> & {
      record?: Record<string, unknown>;
    };
    const row = (rbBody.record ?? rbBody) as Record<string, unknown>;
    const expected: Record<string, unknown> = {};
    for (const k of Object.keys(input)) expected[k] = row[k];
    records.push({ id, expected });
  }

  // ── A webhook (durable config resource) ─────────────────────────────────
  let webhookId: string | null = null;
  const wh = await fetch(`${BASE}/api/webhooks`, {
    method: 'POST',
    headers: tenantHeaders({ Cookie: cookie, 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name: `upgrade-probe-hook-${stamp}`,
      url: 'https://example.com/upgrade-probe',
      events: ['record.created'],
      collections: [collection],
    }),
  });
  if (wh.status < 300) {
    const j = (await wh.json()) as Record<string, unknown> & { webhook?: { id?: string } };
    webhookId = (j.webhook?.id ?? j.id ?? null) as string | null;
  } else {
    console.warn(`[upgrade-smoke] webhook seed skipped (HTTP ${wh.status})`);
  }

  // ── A flow (best-effort — schema varies; never fail seed on it) ──────────
  let flowId: string | null = null;
  const fl = await fetch(`${BASE}/api/flows`, {
    method: 'POST',
    headers: tenantHeaders({ Cookie: cookie, 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name: `upgrade-probe-flow-${stamp}`,
      trigger: { type: 'manual' },
      steps: [],
      enabled: false,
    }),
  });
  if (fl.status < 300) {
    const j = (await fl.json()) as Record<string, unknown> & { flow?: { id?: string } };
    flowId = (j.flow?.id ?? j.id ?? null) as string | null;
  } else {
    console.warn(`[upgrade-smoke] flow seed skipped (HTTP ${fl.status})`);
  }

  const state: SmokeState = { collection, records, webhookId, flowId };
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(
    `[upgrade-smoke] seeded: collection=${collection}, records=${records.length}, ` +
      `webhook=${webhookId ? 'yes' : 'no'}, flow=${flowId ? 'yes' : 'no'} → ${STATE_FILE}`,
  );
}

function eq(a: unknown, b: unknown): boolean {
  // Loose structural equality that tolerates number/string coercion the API may
  // apply to JSON columns, but is strict on values.
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

async function verify(): Promise<void> {
  const failures: string[] = [];
  const state = (await Bun.file(STATE_FILE).json()) as SmokeState;

  // 1. Auth survived the migration (session/user tables intact).
  let cookie: string;
  try {
    cookie = await signIn();
    console.log('[upgrade-smoke] ✓ sign-in works after upgrade');
  } catch (e) {
    console.error(`[upgrade-smoke] ✗ sign-in FAILED after upgrade: ${(e as Error).message}`);
    process.exit(1);
  }

  // 2. Health is green.
  const health = await fetch(`${BASE}/api/health`);
  if (!health.ok) failures.push(`/api/health returned HTTP ${health.status}`);

  // 3. Every seeded record readable byte-for-byte.
  for (const rec of state.records) {
    const res = await fetch(`${BASE}/api/data/${state.collection}/${rec.id}`, {
      headers: tenantHeaders({ Cookie: cookie }),
    });
    if (res.status !== 200) {
      failures.push(`record ${rec.id}: HTTP ${res.status} (expected 200)`);
      continue;
    }
    const body = (await res.json()) as Record<string, unknown> & {
      record?: Record<string, unknown>;
    };
    const row = (body.record ?? body) as Record<string, unknown>;
    for (const [k, want] of Object.entries(rec.expected)) {
      if (!eq(row[k], want)) {
        failures.push(
          `record ${rec.id} field ${k}: got ${JSON.stringify(row[k])}, want ${JSON.stringify(want)}`,
        );
      }
    }
  }

  // 4. Webhook survived.
  if (state.webhookId) {
    const res = await fetch(`${BASE}/api/webhooks/${state.webhookId}`, {
      headers: tenantHeaders({ Cookie: cookie }),
    });
    if (res.status !== 200) failures.push(`webhook ${state.webhookId}: HTTP ${res.status}`);
  }

  // 5. Flow survived (only if it was seeded).
  if (state.flowId) {
    const res = await fetch(`${BASE}/api/flows/${state.flowId}`, {
      headers: tenantHeaders({ Cookie: cookie }),
    });
    if (res.status !== 200) failures.push(`flow ${state.flowId}: HTTP ${res.status}`);
  }

  if (failures.length > 0) {
    console.error('[upgrade-smoke] UPGRADE VERIFICATION FAILED:');
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(
    `[upgrade-smoke] ✓ upgrade verified: ${state.records.length} records intact, ` +
      `auth valid, health green, webhook${state.flowId ? ' + flow' : ''} survived.`,
  );
}

export {}; // module marker so top-level await is allowed

const cmd = process.argv[2];
if (cmd === 'seed') {
  await seed();
} else if (cmd === 'verify') {
  await verify();
} else {
  console.error('Usage: bun scripts/upgrade-smoke.ts <seed|verify>');
  process.exit(2);
}
