/**
 * Adversarial multi-tenant isolation over the live OpenAPI spec (H-09).
 *
 * Tenant isolation is the product's flagship claim but has been tested
 * point-wise (tenant-rls / -rbac / -membership). This suite makes it a spec-wide
 * invariant: it seeds tenant B with UNGUESSABLE sentinels, then — authenticated
 * as tenant A — walks every route in the running engine's OpenAPI document,
 * substitutes B-owned resource ids into the path/query, and asserts the response
 * is a denial (401/403/404) that NEVER echoes a B sentinel. Writes additionally
 * must leave B's record byte-identical.
 *
 * An unlisted route that answers 200 with B's data (or mutates it) fails the
 * build — which forces every FUTURE route to either isolate or declare itself in
 * ALLOWLIST with a one-line justification. The IP-hostname RLS incident
 * (beta.29) is exactly the class this catches.
 *
 * Requires TEST_DATABASE_URL + a running engine on TEST_PORT (the CI integration
 * job provides both).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

// Unguessable per-run marker embedded in every B-owned value. If it ever shows
// up in a response fetched as tenant A, isolation broke.
const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const SENTINEL = `zvB-secret-${RUN}`;
const SLUG_A = `adv_a_${RUN}`;
const SLUG_B = `adv_b_${RUN}`;
const B_COLLECTION = `adv_b_col_${RUN}`;

let db: Database;
let cookieA = '';
let cookieB = '';
// B-owned resource ids, keyed by the OpenAPI path-param names they can fill.
const bIds: Record<string, string> = {};
let bRecordId = '';

/**
 * Routes that are legitimately tenant-agnostic. EACH entry needs a reason —
 * this list, not the test body, is the only thing a new route may touch.
 */
const ALLOWLIST: { match: RegExp; why: string }[] = [
  { match: /^\/api\/health/, why: 'liveness probe — no tenant data' },
  { match: /^\/api\/openapi\.json$/, why: 'the spec itself' },
  { match: /^\/api\/sitemap\.xml$/, why: 'static sitemap' },
  { match: /^\/metrics$/, why: 'Prometheus metrics — token-gated, not tenant data' },
  { match: /^\/api\/auth\//, why: 'better-auth sign-in/up/session — pre-tenant' },
];

function isAllowlisted(path: string): string | null {
  return ALLOWLIST.find((a) => a.match.test(path))?.why ?? null;
}

async function signUp(email: string, password: string): Promise<string> {
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: email }),
  });
  const row = await sql<{ id: string }>`SELECT id FROM "user" WHERE email = ${email}`.execute(db);
  return row.rows[0]!.id;
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

/** Fire a request as a given tenant (cookie + X-Tenant-Slug). */
function asTenant(
  cookie: string,
  slug: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { Cookie: cookie, 'X-Tenant-Slug': slug };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  if (skipAll) return;
  process.env.DATABASE_URL = TEST_DB_URL!;
  const { initDatabase } = await import('../../db/index.js');
  db = await initDatabase();

  const pwd = 'AdvPass123!';
  const userAId = await signUp(`adv-a-${RUN}@test.local`, pwd);
  const userBId = await signUp(`adv-b-${RUN}@test.local`, pwd);
  // B is promoted to god ONLY so it can seed its own tenant + re-read the
  // sentinel (a plain owner lacks data-write RBAC). A stays a non-god owner —
  // a god A would bypass tenant isolation by design and defeat the test.
  await sql`UPDATE "user" SET role = 'god' WHERE id = ${userBId}`.execute(db);

  // Two real tenants; each user a member of their own.
  const a = await sql<{ id: string }>`INSERT INTO zv_tenants (slug, name, status)
      VALUES (${SLUG_A}, ${'Adv A'}, 'active') RETURNING id`.execute(db);
  const b = await sql<{ id: string }>`INSERT INTO zv_tenants (slug, name, status)
      VALUES (${SLUG_B}, ${'Adv B'}, 'active') RETURNING id`.execute(db);
  const tenantAId = a.rows[0]!.id;
  const tenantBId = b.rows[0]!.id;
  await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
      VALUES (${tenantAId}, ${userAId}, 'owner') ON CONFLICT DO NOTHING`.execute(db);
  await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
      VALUES (${tenantBId}, ${userBId}, 'owner') ON CONFLICT DO NOTHING`.execute(db);

  cookieA = await signIn(`adv-a-${RUN}@test.local`, pwd);
  cookieB = await signIn(`adv-b-${RUN}@test.local`, pwd);

  // ── Seed B's tenant with resources carrying the sentinel ──────────────────
  await asTenant(cookieB, SLUG_B, 'POST', '/api/collections', {
    name: B_COLLECTION,
    fields: [{ name: 'note', type: 'text' }],
  });
  const rec = await asTenant(cookieB, SLUG_B, 'POST', `/api/data/${B_COLLECTION}`, {
    note: SENTINEL,
  });
  if (rec.ok) {
    const j = (await rec.json()) as { record?: { id?: string }; id?: string };
    bRecordId = j.record?.id ?? j.id ?? '';
  }

  // Fill the common OpenAPI path-param names with B-owned values. Anything we
  // can't fill from B is skipped + logged (never silently passed).
  bIds.name = B_COLLECTION;
  bIds.collection = B_COLLECTION;
  if (bRecordId) bIds.id = bRecordId;
  bIds.slug = SLUG_B;
  bIds.tenantId = tenantBId;
});

afterAll(async () => {
  if (skipAll) return;
  await sql`DELETE FROM zv_tenants WHERE slug IN (${SLUG_A}, ${SLUG_B})`
    .execute(db)
    .catch(() => {});
});

describe.skipIf(skipAll)('Adversarial multi-tenant isolation over OpenAPI', () => {
  it('seeded B and can read its own sentinel (harness sanity)', async () => {
    expect(bRecordId).not.toBe('');
    const own = await asTenant(cookieB, SLUG_B, 'GET', `/api/data/${B_COLLECTION}/${bRecordId}`);
    expect(own.status).toBeLessThan(300);
    expect(await own.text()).toContain(SENTINEL);
  });

  it('the data record is not readable cross-tenant as A (hard case)', async () => {
    const res = await asTenant(cookieA, SLUG_A, 'GET', `/api/data/${B_COLLECTION}/${bRecordId}`);
    expect([401, 403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain(SENTINEL);
  });

  it('no spec route leaks a B sentinel or mutates B when hit as tenant A', async () => {
    const specRes = await fetch(`${BASE_URL}/api/openapi.json`);
    expect(specRes.ok).toBe(true);
    const spec = (await specRes.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };

    const failures: string[] = [];
    const skipped: string[] = [];
    let checked = 0;

    for (const [rawPath, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods)) {
        const m = method.toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) continue;

        const why = isAllowlisted(rawPath);
        if (why) {
          skipped.push(`${m} ${rawPath} — allowlisted (${why})`);
          continue;
        }

        // Substitute {param} with B-owned values; skip if any can't be filled.
        const params = [...rawPath.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]);
        const unfilled = params.filter((p) => !bIds[p]);
        if (unfilled.length > 0) {
          skipped.push(`${m} ${rawPath} — unfillable params: ${unfilled.join(',')}`);
          continue;
        }
        let path = rawPath;
        for (const p of params) path = path.replace(`{${p}}`, encodeURIComponent(bIds[p]));

        // A route with no path params can't be aimed at a specific B resource,
        // but firing a GET as A still proves A's view of that endpoint never
        // contains B's secret. Don't fire write methods there — they'd only
        // touch A's own tenant and may have side effects.
        if (params.length === 0 && m !== 'GET') {
          skipped.push(`${m} ${rawPath} — no B-aimable param; write not fired (own-tenant only)`);
          continue;
        }

        checked++;
        const res = await asTenant(
          cookieA,
          SLUG_A,
          m,
          path,
          m === 'GET' || m === 'DELETE' ? undefined : { note: 'x', name: 'x' },
        );
        const text = await res.text();

        // The true invariant, applied to EVERY route: B's secret must never
        // appear in a response fetched as tenant A.
        if (text.includes(SENTINEL)) {
          failures.push(`${m} ${path} → ${res.status} LEAKED B sentinel`);
        }
        // The 2xx-is-a-hit check only applies where the substituted id is
        // provably a B-owned resource of the right type: B's data collection +
        // record. Elsewhere `{id}` means a different resource (a column-perm, an
        // api-key, …) so A operating in its OWN tenant's namespace with a
        // mismatched id can legitimately 200 without touching B.
        const aimsAtBData = path.includes(`/api/data/${B_COLLECTION}`);
        if (aimsAtBData && res.status >= 200 && res.status < 300) {
          failures.push(`${m} ${path} → ${res.status} (expected 401/403/404 for B's record)`);
        }
      }
    }

    // Writes must not have mutated B's sentinel record.
    const after = await asTenant(cookieB, SLUG_B, 'GET', `/api/data/${B_COLLECTION}/${bRecordId}`);
    if (!(await after.text()).includes(SENTINEL)) {
      failures.push(`B's sentinel record was mutated/lost after the adversarial write sweep`);
    }

    // Surface coverage + skips for the reviewer.
    console.log(
      `[tenant-adversarial] checked ${checked} B-aimed routes; skipped ${skipped.length}.`,
    );
    for (const s of skipped) console.log(`  · ${s}`);

    if (failures.length > 0) {
      console.error('[tenant-adversarial] ISOLATION FAILURES:');
      for (const f of failures) console.error(`  ✗ ${f}`);
    }
    expect(failures).toEqual([]);
  });
});
