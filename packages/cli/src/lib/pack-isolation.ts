/**
 * Pure isolation resolution for `extension pack` — unit-tested without Bun.build.
 *
 * Sticky footgun: packing as community injects worker into the manifest; a later
 * first-party pack must clear it unless `--keep-isolation` is set.
 */

export type PackIsolation = 'inline' | 'worker' | undefined;

export function resolvePackIsolation(opts: {
  current?: PackIsolation;
  firstParty?: boolean;
  keepIsolation?: boolean;
  /** When true, community tier would auto-inject worker (no explicit isolation). */
  communityInject?: boolean;
}): PackIsolation {
  let resolved: PackIsolation = opts.current;
  if (opts.firstParty && resolved === 'worker' && !opts.keepIsolation) {
    resolved = undefined;
  }
  if (!resolved && opts.communityInject && !opts.firstParty) {
    resolved = 'worker';
  }
  return resolved;
}
