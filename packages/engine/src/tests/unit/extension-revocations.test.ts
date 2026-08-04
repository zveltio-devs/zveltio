/**
 * Revocation checking.
 *
 * A signature proves an artifact came from the registry. It says nothing about
 * whether it should still be running — a backdoored version keeps verifying
 * happily forever. These tests pin the behaviour that decides whether this
 * control survives contact with a real deployment: what happens when the
 * registry cannot be reached.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  checkRevoked,
  clearRevocationCache,
  revocationCheckRequired,
  revocationMessage,
} from '../../lib/extensions/revocations.js';

const REVOKED = {
  name: 'crm/core',
  version: '1.2.0',
  reason: 'Ships a backdoored dependency that exfiltrates session tokens.',
  severity: 'critical' as const,
  advisory_url: 'https://zveltio.com/advisories/ZV-2026-001',
  revoked_at: '2026-07-31T10:00:00.000Z',
};

const originalFetch = globalThis.fetch;
let savedFlag: string | undefined;

function respondWith(body: unknown, ok = true) {
  globalThis.fetch = (async () =>
    ({
      ok,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

function respondWithNetworkError() {
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  clearRevocationCache();
  savedFlag = process.env.ZVELTIO_REQUIRE_REVOCATION_CHECK;
  delete process.env.ZVELTIO_REQUIRE_REVOCATION_CHECK;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedFlag === undefined) delete process.env.ZVELTIO_REQUIRE_REVOCATION_CHECK;
  else process.env.ZVELTIO_REQUIRE_REVOCATION_CHECK = savedFlag;
  clearRevocationCache();
});

describe('matching', () => {
  it('revokes the exact version', async () => {
    respondWith({ generated_at: '2026-07-31T10:00:00Z', revocations: [REVOKED] });
    const v = await checkRevoked('crm/core', '1.2.0');
    expect(v.revoked).toBe(true);
    expect(v.entry?.reason).toContain('backdoored');
  });

  it('leaves other versions of the same extension alone', async () => {
    respondWith({ revocations: [REVOKED] });
    expect((await checkRevoked('crm/core', '1.3.0')).revoked).toBe(false);
  });

  it("'*' revokes every version — the compromised-publisher case", async () => {
    respondWith({ revocations: [{ ...REVOKED, version: '*' }] });
    expect((await checkRevoked('crm/core', '1.3.0')).revoked).toBe(true);
    expect((await checkRevoked('crm/core', '0.0.1')).revoked).toBe(true);
  });

  it("matches '*' even when the caller does not know the version", async () => {
    respondWith({ revocations: [{ ...REVOKED, version: '*' }] });
    expect((await checkRevoked('crm/core')).revoked).toBe(true);
  });

  it('does not revoke an extension that is not listed', async () => {
    respondWith({ revocations: [REVOKED] });
    expect((await checkRevoked('billing/stripe', '1.0.0')).revoked).toBe(false);
  });
});

describe('when the registry is unreachable', () => {
  it('fails OPEN by default, reporting that it does not know', async () => {
    // Air-gapped installs are a supported deployment. Refusing to enable
    // anything without a remote list would brick them, and the operator's fix
    // would be to disable the check permanently — a control that gets switched
    // off protects nobody.
    respondWithNetworkError();
    const v = await checkRevoked('crm/core', '1.2.0');
    expect(v.revoked).toBe(false);
    expect(v.unknown).toBe(true);
  });

  it('can be made to block, for a connected fleet', async () => {
    expect(revocationCheckRequired()).toBe(false);
    process.env.ZVELTIO_REQUIRE_REVOCATION_CHECK = '1';
    expect(revocationCheckRequired()).toBe(true);
  });

  it('treats a non-200 as unreachable rather than as an empty list', async () => {
    // A 500 that parsed as "nothing is revoked" would silently un-revoke
    // everything at exactly the moment the registry is having trouble.
    respondWith({ revocations: [REVOKED] }, false);
    expect((await checkRevoked('crm/core', '1.2.0')).unknown).toBe(true);
  });

  it('keeps enforcing a list it already fetched', async () => {
    respondWith({ revocations: [REVOKED] });
    expect((await checkRevoked('crm/core', '1.2.0')).revoked).toBe(true);

    // The registry goes down. Its being down is not evidence that a revoked
    // build became safe.
    respondWithNetworkError();
    const v = await checkRevoked('crm/core', '1.2.0');
    expect(v.revoked).toBe(true);
    expect(v.unknown).toBe(false);
  });
});

describe('caching', () => {
  it('does not hit the registry once per check', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: true, json: async () => ({ revocations: [REVOKED] }) } as unknown as Response;
    }) as unknown as typeof fetch;

    await checkRevoked('crm/core', '1.2.0');
    await checkRevoked('billing/stripe', '1.0.0');
    await checkRevoked('crm/core', '1.3.0');
    expect(calls).toBe(1);
  });

  it('coalesces concurrent first checks into one request', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, json: async () => ({ revocations: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;

    await Promise.all([checkRevoked('a/b'), checkRevoked('c/d'), checkRevoked('e/f')]);
    expect(calls).toBe(1);
  });
});

describe('malformed responses', () => {
  it('ignores entries without a name or version instead of throwing', async () => {
    respondWith({ revocations: [{ reason: 'no name' }, REVOKED, null, 'string'] });
    expect((await checkRevoked('crm/core', '1.2.0')).revoked).toBe(true);
  });

  it('survives a body with no revocations array', async () => {
    respondWith({ generated_at: '2026-07-31T10:00:00Z' });
    const v = await checkRevoked('crm/core', '1.2.0');
    expect(v.revoked).toBe(false);
    expect(v.unknown).toBe(false);
  });
});

describe('the operator message', () => {
  it('carries the reason, severity and advisory link', () => {
    // "Revoked" with no explanation reads as a registry glitch to work around.
    const msg = revocationMessage('crm/core', '1.2.0', REVOKED);
    expect(msg).toContain('crm/core');
    expect(msg).toContain('critical');
    expect(msg).toContain('backdoored');
    expect(msg).toContain('ZV-2026-001');
  });
});

/**
 * Wiring — the part that was missing.
 *
 * Every test above exercises `checkRevoked` directly. All of them passed while
 * the module was imported by exactly one file: the marketplace routes. So the
 * list was consulted when an operator INSTALLED or hot-loaded an extension,
 * and never when the engine BOOTED. An extension revoked after it was already
 * on disk kept loading on every restart — precisely the situation revocation
 * exists for, and the one the module's own docstring names.
 *
 * These tests go through `loadExtensionFromDir`, the single function every
 * entry point reaches (boot `loadFromDB`, `loadDynamic`, marketplace install).
 */
describe('load-path enforcement', () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');

  function extensionOnDisk(opts: { version: string; engine?: boolean }) {
    const base = mkdtempSync(join(tmpdir(), 'zv-revoke-'));
    const dir = join(base, 'crm/core');
    mkdirSync(join(dir, 'engine'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: 'crm/core',
        version: opts.version,
        contributes: { engine: opts.engine ?? true },
      }),
    );
    // A real bundle, so nothing else in the pipeline can be what stops the load.
    writeFileSync(join(dir, 'engine/index.js'), 'export default { name: "crm/core" };');
    return base;
  }

  function stubLoader() {
    return {
      loaded: new Map(),
      manifestMeta: new Map(),
      lastLoadError: new Map(),
      modules: new Map(),
      isActive(name: string) {
        return this.loaded.has(name);
      },
    };
  }

  async function load(base: string) {
    const { loadExtensionFromDir } = await import('../../lib/extensions/load.js');
    const loader = stubLoader();
    // db is only touched for `manifest.dependencies`, which this manifest omits.
    const ctx = { db: {} } as never;
    await loadExtensionFromDir(loader as never, 'crm/core', {} as never, ctx, base);
    return loader;
  }

  it('refuses a revoked extension at boot, not just at install', async () => {
    respondWith({ revocations: [REVOKED] });
    const loader = await load(extensionOnDisk({ version: '1.2.0' }));

    expect(loader.isActive('crm/core')).toBe(false);
    expect(loader.lastLoadError.get('crm/core')).toContain('REVOKED');
    // The reason has to reach the operator, or the badge reads as a glitch.
    expect(loader.lastLoadError.get('crm/core')).toContain('backdoored');
  });

  it('refuses a revoked Studio-only extension too', async () => {
    // `contributes.engine: false` short-circuits early and marks the extension
    // active. A gate placed after that branch would wave this one through, and
    // a client-only extension still ships code to every operator's browser.
    respondWith({ revocations: [REVOKED] });
    const loader = await load(extensionOnDisk({ version: '1.2.0', engine: false }));

    expect(loader.isActive('crm/core')).toBe(false);
    expect(loader.lastLoadError.get('crm/core')).toContain('REVOKED');
  });

  // The two below assert that revocation is not what stopped the load. They
  // deliberately do not assert the extension finished loading: later gates
  // (publisher tier, entry resolution) have their own opinions and their own
  // tests, and pinning those here would make this file fail for reasons that
  // have nothing to do with revocation.
  function stoppedByRevocation(loader: { lastLoadError: Map<string, string> }) {
    const err = loader.lastLoadError.get('crm/core') ?? '';
    return err.includes('REVOKED') || err.includes('has been revoked');
  }

  it('does not stop a version the list omits', async () => {
    respondWith({ revocations: [REVOKED] });
    const loader = await load(extensionOnDisk({ version: '1.3.0' }));
    expect(stoppedByRevocation(loader as never)).toBe(false);
  });

  it('does not stop the load when the registry is unreachable — air-gapped installs still boot', async () => {
    respondWithNetworkError();
    const loader = await load(extensionOnDisk({ version: '1.2.0' }));
    expect(stoppedByRevocation(loader as never)).toBe(false);
  });

  it('refuses to boot on an unreachable registry when the operator demands the check', async () => {
    process.env.ZVELTIO_REQUIRE_REVOCATION_CHECK = '1';
    respondWithNetworkError();
    const loader = await load(extensionOnDisk({ version: '1.2.0' }));

    expect(loader.isActive('crm/core')).toBe(false);
    expect(loader.lastLoadError.get('crm/core')).toContain('unreachable');
  });
});
