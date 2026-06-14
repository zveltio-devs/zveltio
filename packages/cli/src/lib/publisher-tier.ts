/**
 * Publisher tier resolution for the CLI (MARKETPLACE-POLICY §2).
 *
 * The engine refuses `engine.isolation: "inline"` for community-tier
 * extensions at enable. To save authors a round-trip through the review
 * queue, the CLI resolves the tier *before* pack/validate/publish and
 * applies the same rule locally.
 *
 * Resolution order (first match wins):
 *   1. `--first-party` flag        → 'first-party'  (offline, monorepo /
 *                                     vendor builds — the Zveltio team)
 *   2. registry `/api/dev/publisher/self` (when a token is available)
 *                                  → the publisher's actual tier
 *   3. fallback                    → 'community'     (the strictest tier)
 *
 * The registry lookup is best-effort: network failures, missing tokens,
 * and 4xx all degrade to the conservative community default rather than
 * blocking an offline `validate`.
 */

export type PublisherTier = 'first-party' | 'verified' | 'community';

export function tierAllowsInline(tier: PublisherTier): boolean {
  return tier === 'first-party' || tier === 'verified';
}

export interface ResolveTierOptions {
  /** `--first-party` flag — short-circuits to first-party offline. */
  firstParty?: boolean;
  /** Registry base URL. Defaults to env or the public registry. */
  registryUrl?: string;
  /** Bearer token. Defaults to ZVELTIO_REGISTRY_TOKEN. */
  token?: string;
  /** Scope the lookup to a specific signing key (the one publish uses). */
  keyId?: string;
}

export interface ResolvedTier {
  tier: PublisherTier;
  allowsInline: boolean;
  /** How the tier was determined — drives how loud the CLI should be. */
  source: 'flag' | 'registry' | 'default';
}

/**
 * Resolve the publisher tier. Never throws — a failed registry lookup
 * degrades to `{ tier: 'community', source: 'default' }`.
 */
export async function resolvePublisherTier(opts: ResolveTierOptions = {}): Promise<ResolvedTier> {
  if (opts.firstParty) {
    return { tier: 'first-party', allowsInline: true, source: 'flag' };
  }

  const token = opts.token ?? process.env.ZVELTIO_REGISTRY_TOKEN;
  const registryUrl =
    opts.registryUrl ?? process.env.ZVELTIO_REGISTRY_URL ?? 'https://registry.zveltio.com';

  if (token) {
    try {
      const base = registryUrl.replace(/\/$/, '');
      const url = new URL(`${base}/api/dev/publisher/self`);
      if (opts.keyId) url.searchParams.set('keyId', opts.keyId);
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { tier?: PublisherTier };
        const tier = normalizeTier(data.tier);
        if (tier) {
          return { tier, allowsInline: tierAllowsInline(tier), source: 'registry' };
        }
      }
    } catch {
      /* network / timeout / parse — fall through to the safe default */
    }
  }

  return { tier: 'community', allowsInline: false, source: 'default' };
}

function normalizeTier(v: unknown): PublisherTier | null {
  return v === 'first-party' || v === 'verified' || v === 'community' ? v : null;
}
