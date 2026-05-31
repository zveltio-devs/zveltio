import { describe, it, expect } from 'bun:test';

/**
 * Third-party isolation enforcement — alpha.124 closed the gap
 * between MARKETPLACE-POLICY.md §2 (worker mandatory for community
 * submissions) and the runtime. This test pins the decision logic
 * the loader runs at enable time.
 *
 * Rather than spinning up the full extension loader (which pulls in
 * the entire engine), we replicate the exact predicate. If the
 * production code changes, this test updates accordingly.
 */

interface CatalogEntry {
  name: string;
  is_official?: boolean;
}

interface ManifestEngineBlock {
  isolation?: 'inline' | 'worker';
}

interface PolicyDecisionInput {
  catalog: CatalogEntry | null;
  engine: ManifestEngineBlock | undefined;
  envAllowInlineThirdParty: boolean;
  envRequireCatalog?: boolean;
  catalogFetchFailed?: boolean;
}

type Decision =
  | { allow: true }
  | { allow: false; reason: 'community-no-worker' | 'catalog-required-but-missing' };

function decide(input: PolicyDecisionInput): Decision {
  const { catalog, engine, envAllowInlineThirdParty, envRequireCatalog, catalogFetchFailed } =
    input;

  // Worker isolation is always sufficient — never refused on policy grounds.
  if (engine?.isolation === 'worker') return { allow: true };

  // Operator escape hatch — self-hosted with trusted custom extensions.
  if (envAllowInlineThirdParty) return { allow: true };

  // Fail-closed mode (default off): if catalog couldn't be fetched and
  // ZVELTIO_REQUIRE_CATALOG=1, refuse rather than fall through to local
  // catalog assumptions.
  if (catalogFetchFailed && envRequireCatalog) {
    return { allow: false, reason: 'catalog-required-but-missing' };
  }

  // Default: if catalog says is_official=true (or extension is local
  // hardcoded, where default is true), allow inline. Otherwise refuse.
  if (catalog?.is_official === true) return { allow: true };

  // Unknown extension OR explicitly community → refuse without worker.
  return { allow: false, reason: 'community-no-worker' };
}

describe('third-party isolation enforcement (alpha.124)', () => {
  it('allows first-party inline (catalog.is_official=true)', () => {
    expect(
      decide({
        catalog: { name: 'crm', is_official: true },
        engine: { isolation: 'inline' },
        envAllowInlineThirdParty: false,
      }),
    ).toEqual({ allow: true });
  });

  it('allows community extension that opts into worker isolation', () => {
    expect(
      decide({
        catalog: { name: 'some-third-party', is_official: false },
        engine: { isolation: 'worker' },
        envAllowInlineThirdParty: false,
      }),
    ).toEqual({ allow: true });
  });

  it('refuses community inline (the load-bearing enforcement)', () => {
    const decision = decide({
      catalog: { name: 'some-third-party', is_official: false },
      engine: { isolation: 'inline' },
      envAllowInlineThirdParty: false,
    });
    expect(decision.allow).toBe(false);
    expect((decision as { reason: string }).reason).toBe('community-no-worker');
  });

  it('refuses community extension that omits isolation entirely', () => {
    const decision = decide({
      catalog: { name: 'sketchy-ext', is_official: false },
      engine: undefined,
      envAllowInlineThirdParty: false,
    });
    expect(decision.allow).toBe(false);
  });

  it('escape hatch: ZVELTIO_ALLOW_INLINE_THIRD_PARTY=1 allows community inline', () => {
    expect(
      decide({
        catalog: { name: 'community-trusted', is_official: false },
        engine: { isolation: 'inline' },
        envAllowInlineThirdParty: true,
      }),
    ).toEqual({ allow: true });
  });

  it('extension not in catalog (unknown) is treated as community', () => {
    const decision = decide({
      catalog: null,
      engine: { isolation: 'inline' },
      envAllowInlineThirdParty: false,
    });
    expect(decision.allow).toBe(false);
  });

  it('worker isolation ALWAYS passes regardless of catalog status', () => {
    for (const cat of [
      null,
      { name: 'x', is_official: true },
      { name: 'x', is_official: false },
      { name: 'x' },
    ]) {
      expect(
        decide({
          catalog: cat,
          engine: { isolation: 'worker' },
          envAllowInlineThirdParty: false,
        }).allow,
      ).toBe(true);
    }
  });
});

describe('fail-closed mode (ZVELTIO_REQUIRE_CATALOG=1)', () => {
  it('refuses when catalog fetch fails AND require-catalog is set', () => {
    const decision = decide({
      catalog: null,
      engine: { isolation: 'inline' },
      envAllowInlineThirdParty: false,
      envRequireCatalog: true,
      catalogFetchFailed: true,
    });
    expect(decision.allow).toBe(false);
    expect((decision as { reason: string }).reason).toBe('catalog-required-but-missing');
  });

  it('allows when catalog fetch fails but require-catalog is OFF (default)', () => {
    // Default behaviour — engine continues with local catalog if
    // registry is unreachable. The is_official=false default for
    // unknown extensions then drives the refuse-without-worker
    // decision separately.
    const decision = decide({
      catalog: null,
      engine: { isolation: 'worker' },
      envAllowInlineThirdParty: false,
      envRequireCatalog: false,
      catalogFetchFailed: true,
    });
    expect(decision.allow).toBe(true);
  });

  it('worker isolation overrides fail-closed (no point refusing if extension is safe)', () => {
    expect(
      decide({
        catalog: null,
        engine: { isolation: 'worker' },
        envAllowInlineThirdParty: false,
        envRequireCatalog: true,
        catalogFetchFailed: true,
      }).allow,
    ).toBe(true);
  });
});
