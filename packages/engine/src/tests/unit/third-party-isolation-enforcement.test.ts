import { describe, it, expect } from 'bun:test';

/**
 * Third-party isolation enforcement — alpha.124 closed the gap
 * between MARKETPLACE-POLICY.md §2 (worker mandatory for community
 * submissions) and the runtime. beta.2 extended the binary
 * official/community decision into the full three-tier model
 * (first-party / verified / community) so verified partners may run
 * inline. This test pins the decision logic the loader runs at enable
 * time.
 *
 * The tier-resolution helpers come straight from the production
 * extension-catalog module; the surrounding decision flow replicates
 * the loader predicate. If the production code changes, this test
 * updates accordingly.
 */
import { resolvePublisherTier, tierAllowsInline } from '../../lib/extension-catalog.js';

type PublisherTier = 'first-party' | 'verified' | 'community';

interface CatalogEntry {
  name: string;
  is_official?: boolean;
  publisher_tier?: PublisherTier;
}

interface ManifestEngineBlock {
  isolation?: 'inline' | 'worker';
}

interface PolicyDecisionInput {
  /**
   * The matched catalog entry, or null. Two distinct null meanings,
   * disambiguated by `catalogFetchFailed`:
   *   - catalog loaded but this extension is ABSENT → unknown/unaudited
   *     → treated as community (refuse inline)
   *   - catalog couldn't be fetched at all          → fall back per
   *     `envRequireCatalog`
   */
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

  // Registry unreachable + fail-closed OFF (default): the gate can't be
  // applied, so the engine continues on local-only assumptions rather
  // than blocking every inline extension during a registry outage.
  if (catalogFetchFailed) return { allow: true };

  // Catalog loaded. A matched entry uses its declared tier; an ABSENT
  // entry is unknown/unaudited and resolves to community (refuse inline).
  const tier = catalog ? resolvePublisherTier(catalog) : 'community';
  if (tierAllowsInline(tier)) return { allow: true };
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

  it('allows verified-tier inline (beta.2 — verified may run inline)', () => {
    expect(
      decide({
        catalog: { name: 'acme-crm', is_official: false, publisher_tier: 'verified' },
        engine: { isolation: 'inline' },
        envAllowInlineThirdParty: false,
      }),
    ).toEqual({ allow: true });
  });

  it('allows first-party-tier inline via publisher_tier (not just is_official)', () => {
    expect(
      decide({
        catalog: { name: 'crm', publisher_tier: 'first-party' },
        engine: { isolation: 'inline' },
        envAllowInlineThirdParty: false,
      }),
    ).toEqual({ allow: true });
  });

  it('refuses community-tier inline even when publisher_tier is explicit', () => {
    const decision = decide({
      catalog: { name: 'newcomer', is_official: false, publisher_tier: 'community' },
      engine: { isolation: 'inline' },
      envAllowInlineThirdParty: false,
    });
    expect(decision.allow).toBe(false);
    expect((decision as { reason: string }).reason).toBe('community-no-worker');
  });

  it('publisher_tier takes precedence over is_official when both present', () => {
    // A row that's is_official=false but tier=verified (e.g. a verified
    // partner) must be allowed inline — the tier wins.
    expect(
      decide({
        catalog: { name: 'partner-ext', is_official: false, publisher_tier: 'verified' },
        engine: { isolation: 'inline' },
        envAllowInlineThirdParty: false,
      }).allow,
    ).toBe(true);
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

  it('extension absent from a LOADED catalog (unknown) is refused inline', () => {
    // catalog loaded successfully (catalogFetchFailed falsy) but the
    // extension isn't in it → unknown/unaudited → community → refuse.
    // This is the beta.2 tightening: previously the gate was skipped
    // when the entry wasn't found, letting a sideloaded inline extension
    // slip past.
    const decision = decide({
      catalog: null,
      engine: { isolation: 'inline' },
      envAllowInlineThirdParty: false,
    });
    expect(decision.allow).toBe(false);
    expect((decision as { reason: string }).reason).toBe('community-no-worker');
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

  it('inline is ALLOWED when fetch fails and require-catalog is OFF (outage fallback)', () => {
    // Distinct from "absent from a loaded catalog": here the registry is
    // unreachable entirely. Blocking every inline extension during an
    // outage would be worse than the risk, so the gate yields. The
    // operator opts into fail-closed with ZVELTIO_REQUIRE_CATALOG=1.
    const decision = decide({
      catalog: null,
      engine: { isolation: 'inline' },
      envAllowInlineThirdParty: false,
      envRequireCatalog: false,
      catalogFetchFailed: true,
    });
    expect(decision.allow).toBe(true);
  });
});
