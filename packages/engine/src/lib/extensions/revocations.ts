/**
 * Revocation list — artifacts the registry no longer stands behind.
 *
 * Signing proves an artifact came from the registry. It says nothing about
 * whether it should still be running. Once a published version turns out to be
 * backdoored or catastrophically broken, its signature keeps verifying happily
 * and every install that already has the files keeps running it. Signature
 * checks and revocation answer different questions; having one is not having
 * the other.
 *
 * Two decisions shape this module, and both are about what happens when the
 * registry is NOT reachable.
 *
 * **Never-fetched fails OPEN.** Zveltio is self-hosted and explicitly supports
 * air-gapped installs (EXTENSIONS_DIR, no registry at all). Refusing to enable
 * anything until a remote list has been fetched would brick exactly the
 * deployments that chose to be isolated, and the operator's fix would be to
 * disable the check permanently. A control that gets switched off protects
 * nobody. Set `ZVELTIO_REQUIRE_REVOCATION_CHECK=1` to invert this for a
 * connected fleet where an unreachable registry SHOULD block.
 *
 * **A cached list keeps enforcing after it goes stale.** The registry being
 * down is not evidence that a revoked build became safe. Staleness is surfaced
 * so an operator can see the list is old, but an entry already fetched keeps
 * refusing until it is withdrawn.
 */

import { REGISTRY_URL } from './extension-download.js';

export interface Revocation {
  name: string;
  /** Exact version, or '*' for every version published. */
  version: string;
  reason: string;
  severity: 'critical' | 'high' | 'advisory';
  advisory_url: string | null;
  revoked_at: string;
}

interface CachedList {
  fetchedAt: number;
  generatedAt: string | null;
  revocations: Revocation[];
}

/** How long a fetched list is served before we try the registry again. */
const TTL_MS = 5 * 60 * 1000;

/**
 * How long a FAILED fetch is remembered before trying again.
 *
 * A failure was not remembered at all: `fetchList` returned null, `_cache`
 * stayed null, and the very next caller started another request. Every
 * extension load therefore paid the full 5-second connect timeout, one after
 * another, on exactly the deployment this file says it supports — air-gapped,
 * or a registry that is simply down. Fifty-seven extensions is nearly five
 * minutes of boot spent waiting on a host that is not there.
 *
 * Short enough that a registry coming back up is picked up within a minute,
 * long enough that a boot does not re-dial it once per extension.
 */
const FAILURE_COOLDOWN_MS = 60 * 1000;

let _cache: CachedList | null = null;
let _inflight: Promise<CachedList | null> | null = null;
let _failedAt = 0;

/** Test seam + a way for an operator action to force a re-check. */
export function clearRevocationCache(): void {
  _cache = null;
  _inflight = null;
  _failedAt = 0;
}

async function fetchList(): Promise<CachedList | null> {
  try {
    const res = await fetch(`${REGISTRY_URL}/api/revocations`, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      generated_at?: string;
      revocations?: unknown;
    };
    const list = Array.isArray(body.revocations) ? body.revocations : [];
    return {
      fetchedAt: Date.now(),
      generatedAt: typeof body.generated_at === 'string' ? body.generated_at : null,
      revocations: list.filter(
        (r): r is Revocation =>
          typeof (r as Revocation)?.name === 'string' &&
          typeof (r as Revocation)?.version === 'string',
      ),
    };
  } catch {
    return null;
  }
}

/**
 * The current list, refreshed at most once per TTL.
 *
 * A failed refresh keeps the previous list rather than dropping to "nothing is
 * revoked" — losing contact with the registry must not silently un-revoke
 * anything.
 */
async function getList(): Promise<CachedList | null> {
  if (_cache && Date.now() - _cache.fetchedAt < TTL_MS) return _cache;
  // Recently failed: serve whatever we have (possibly nothing) without
  // re-dialling a registry that just did not answer.
  if (Date.now() - _failedAt < FAILURE_COOLDOWN_MS) return _cache;
  if (!_inflight) {
    _inflight = fetchList().finally(() => {
      _inflight = null;
    });
  }
  const fresh = await _inflight;
  if (fresh) _cache = fresh;
  else _failedAt = Date.now();
  return _cache;
}

export interface RevocationVerdict {
  /** True when this exact name/version must not be installed or enabled. */
  revoked: boolean;
  entry?: Revocation;
  /** True when no list has ever been fetched (air-gapped or registry down). */
  unknown: boolean;
  /** Age of the cached list in ms, when there is one. */
  ageMs?: number;
}

/**
 * Whether `name@version` is revoked.
 *
 * `version` may be omitted when the caller does not know it — a `'*'` entry
 * still matches, which is the case that matters most (a compromised publisher,
 * where every build is suspect).
 */
export async function checkRevoked(name: string, version?: string): Promise<RevocationVerdict> {
  const list = await getList();
  if (!list) return { revoked: false, unknown: true };

  const entry = list.revocations.find(
    (r) =>
      r.name === name && (r.version === '*' || (version !== undefined && r.version === version)),
  );
  return {
    revoked: Boolean(entry),
    entry,
    unknown: false,
    ageMs: Date.now() - list.fetchedAt,
  };
}

/** Whether an unreachable registry should block rather than warn. */
export function revocationCheckRequired(): boolean {
  const v = process.env.ZVELTIO_REQUIRE_REVOCATION_CHECK;
  return v === '1' || v === 'true';
}

/**
 * The message an operator sees. Revocations only work if the reason travels
 * with them — "revoked" alone reads as a registry glitch to work around.
 */
export function revocationMessage(name: string, version: string, entry: Revocation): string {
  return (
    `Extension "${name}"@${version} has been REVOKED by the registry ` +
    `(${entry.severity}): ${entry.reason}` +
    (entry.advisory_url ? ` — see ${entry.advisory_url}` : '') +
    `. Revoked ${entry.revoked_at}.`
  );
}
