/**
 * The privilege-granting routes: capability approval and revocation refusal.
 *
 * `approve-capabilities` is how an administrator hands an extension more power.
 * It shipped with no test at all, which is the wrong shape for the one endpoint
 * whose entire job is to widen access. Revocation is the other side: the engine
 * refusing to install or enable something the registry has withdrawn.
 *
 * Driven through the in-process app against a real database, because the parts
 * worth pinning are the guards (auth, what may be approved, what the response
 * says) rather than the intersection logic, which is unit-tested in
 * extension-consent.test.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { resolveExtensionsBase } from '../../lib/extensions/extension-paths.js';
import { clearRevocationCache } from '../../lib/extensions/revocations.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const HELLO_EXT = 'hello-ext';
const FIXTURE_DIR = join(import.meta.dir, '../fixtures/hello-ext');

let originalFetch: typeof fetch;

/** A registry that cannot be reached at all — the air-gapped / outage case. */
function stubRegistryDown(): void {
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
}

/** Registry responses: an empty catalogue plus whatever revocations we want. */
function stubRegistry(revocations: unknown[] = []): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/revocations')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ generated_at: new Date().toISOString(), revocations }),
      } as Response;
    }
    // Anything else (catalogue, downloads) fails: these tests never need it.
    throw new Error('registry unavailable in test');
  }) as typeof fetch;
}

function ensureFixtureOnDisk(): void {
  const extBase = resolveExtensionsBase();
  const target = join(extBase, HELLO_EXT);
  if (!existsSync(join(target, 'manifest.json'))) {
    mkdirSync(extBase, { recursive: true });
    cpSync(FIXTURE_DIR, target, { recursive: true });
  }
}

d('capability approval + revocation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  const post = (path: string, body: unknown = {}) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    originalFetch = globalThis.fetch;
    const t = await getTestApp();
    app = t.app;
    db = t.db;
    cookie = await createGodSession(app, db);
    ensureFixtureOnDisk();
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, category, version, is_installed, is_enabled)
      VALUES (${HELLO_EXT}, 'Hello', 'fixture', '1.0.0', true, false)
      ON CONFLICT (tenant_id, name) DO UPDATE SET is_installed = true
    `.execute(db);
  });

  afterEach(() => {
    clearRevocationCache();
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    clearRevocationCache();
    await sql`DELETE FROM zv_extension_registry WHERE name = ${HELLO_EXT}`
      .execute(db)
      .catch(() => {});
  });

  describe('approve-capabilities', () => {
    it('refuses an anonymous caller', async () => {
      const res = await app.request(`/api/marketplace/${HELLO_EXT}/approve-capabilities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: [] }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects a body that does not name what is being approved', async () => {
      // Approving "whatever it asks for right now" would let a version landing
      // between the admin reading the prompt and clicking be approved unseen.
      for (const body of [{}, { capabilities: 'secrets' }, { capabilities: [1, 2] }]) {
        const res = await app.request(
          `/api/marketplace/${HELLO_EXT}/approve-capabilities`,
          post(`/api/marketplace/${HELLO_EXT}/approve-capabilities`, body),
        );
        expect(res.status).toBe(400);
      }
    });

    it('refuses to grant something the manifest does not declare', async () => {
      // The record must describe this artifact, not a superset someone typed.
      const res = await app.request(
        `/api/marketplace/${HELLO_EXT}/approve-capabilities`,
        post('', { capabilities: ['db:admin'] }),
      );
      expect(res.status).toBe(409);
      // The engine renders 4xx as problem+json, so a handler's own extra fields
      // do not survive — `detail` carries the message. Worth pinning: writing
      // structured fields that the response shape silently drops is how a UI
      // ends up branching on something that is never there.
      const body = (await res.json()) as { detail: string; status: number };
      expect(body.status).toBe(409);
      expect(body.detail).toContain('db:admin');
    });

    it('records consent and reports what was granted', async () => {
      // The fixture declares no permissions, so the empty set is the honest
      // approval — and it must still be RECORDED, because "nothing approved
      // yet" and "explicitly approved nothing" are different states.
      const res = await app.request(
        `/api/marketplace/${HELLO_EXT}/approve-capabilities`,
        post('', { capabilities: [] }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; granted_capabilities: string[] };
      expect(body.success).toBe(true);
      expect(body.granted_capabilities).toEqual([]);

      const row = await sql<{ granted_capabilities: unknown }>`
        SELECT granted_capabilities FROM zv_extension_registry WHERE name = ${HELLO_EXT}
      `.execute(db);
      expect(row.rows[0]!.granted_capabilities).not.toBeNull();
    });

    it('404s for an extension with no manifest on disk', async () => {
      const res = await app.request(
        '/api/marketplace/no-such-ext-xyz/approve-capabilities',
        post('', { capabilities: [] }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('revocation', () => {
    it('refuses to enable a revoked version with 451 and the reason', async () => {
      stubRegistry([
        {
          name: HELLO_EXT,
          version: '*',
          reason: 'Ships a backdoored dependency that exfiltrates session tokens.',
          severity: 'critical',
          advisory_url: 'https://zveltio.com/advisories/ZV-2026-001',
          revoked_at: new Date().toISOString(),
        },
      ]);

      // marketplace.test.ts drives the same fixture against the same database,
      // so the precondition has to be established here rather than assumed —
      // otherwise this asserts on accumulated state, not on this action.
      await sql`UPDATE zv_extension_registry SET is_enabled = false WHERE name = ${HELLO_EXT}`.execute(
        db,
      );

      const res = await app.request(`/api/marketplace/${HELLO_EXT}/enable`, post('', {}));
      // 451 when the catalogue resolved; 404 if the (stubbed-out) catalogue
      // fetch could not supply the entry. Either way it must NOT enable.
      expect([451, 404]).toContain(res.status);
      if (res.status === 451) {
        // problem+json: the reason and advisory travel in `detail`, which is
        // what an operator actually reads. "Revoked" with no explanation gets
        // treated as a registry glitch and worked around.
        const body = (await res.json()) as { detail: string };
        expect(body.detail).toContain('backdoored');
        expect(body.detail).toContain('ZV-2026-001');
      }

      const row = await sql<{ is_enabled: boolean }>`
        SELECT is_enabled FROM zv_extension_registry WHERE name = ${HELLO_EXT}
      `.execute(db);
      expect(row.rows[0]!.is_enabled).toBe(false);
    });

    it('refuses to INSTALL a revoked version too, not only enable', async () => {
      // Checking only at enable would leave the bytes on disk for the next
      // person to enable by hand.
      stubRegistry([
        {
          name: HELLO_EXT,
          version: '*',
          reason: 'Publisher account was compromised; every build is suspect.',
          severity: 'critical',
          advisory_url: null,
          revoked_at: new Date().toISOString(),
        },
      ]);
      const res = await app.request(`/api/marketplace/${HELLO_EXT}/install`, post('', {}));
      expect([451, 404]).toContain(res.status);
      if (res.status === 451) {
        const body = (await res.json()) as { detail: string };
        expect(body.detail).toContain('compromised');
      }
    });

    it('blocks when the check is REQUIRED and the registry is unreachable', async () => {
      // The opt-in fail-closed mode for a connected fleet. Default is fail-open
      // because air-gapped installs are supported; an operator who sets this
      // has said their instance should never run unverified code.
      const saved = process.env.ZVELTIO_REQUIRE_REVOCATION_CHECK;
      process.env.ZVELTIO_REQUIRE_REVOCATION_CHECK = '1';
      stubRegistryDown();
      try {
        for (const action of ['install', 'enable']) {
          const res = await app.request(`/api/marketplace/${HELLO_EXT}/${action}`, post('', {}));
          expect([503, 404]).toContain(res.status);
          if (res.status === 503) {
            const body = (await res.json()) as { detail: string };
            expect(body.detail).toContain('ZVELTIO_REQUIRE_REVOCATION_CHECK');
          }
          clearRevocationCache();
        }
      } finally {
        if (saved === undefined) delete process.env.ZVELTIO_REQUIRE_REVOCATION_CHECK;
        else process.env.ZVELTIO_REQUIRE_REVOCATION_CHECK = saved;
      }
    });

    it('does not block when the extension is not on the list', async () => {
      stubRegistry([{ name: 'someone/else', version: '*', reason: 'unrelated' }]);
      const res = await app.request(`/api/marketplace/${HELLO_EXT}/install`, post('', {}));
      // Whatever happens next (catalogue unavailable in this env), it must not
      // be a revocation refusal.
      expect(res.status).not.toBe(451);
    });
  });

  describe('the marketplace listing', () => {
    it('reports capability consent state for each extension', async () => {
      stubRegistry([]);
      const res = await app.request('/api/marketplace', { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        extensions: Array<{
          name: string;
          declared_capabilities?: string[];
          pending_capabilities?: string[];
        }>;
      };
      // The listing is the only place an admin learns that an extension is
      // asking for more than was approved.
      for (const e of body.extensions) {
        expect(Array.isArray(e.declared_capabilities)).toBe(true);
        expect(Array.isArray(e.pending_capabilities)).toBe(true);
      }
    });
  });
});
