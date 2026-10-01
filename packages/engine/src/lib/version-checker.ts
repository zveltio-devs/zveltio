import type { Database } from '../db/index.js';
import { ENGINE_VERSION } from '../version.js';

/**
 * Checks compatibility of an extension with the current engine version.
 *
 * Full semver, prerelease included. The engine ships as `3.0.0-beta.N`, and the
 * old `split('.')` parser read its patch as `Number('0-beta')`, NaN: every
 * comparison against a beta came out "compatible", so a `zveltioMinVersion` of
 * `3.0.0-beta.73` admitted beta.72. A version that is not semver is refused,
 * not waved through.
 */
export function isCompatible(
  engineVersion: string,
  extMinVersion?: string | null,
  extMaxVersion?: string | null,
): { compatible: boolean; reason?: string } {
  if (!extMinVersion) return { compatible: true };

  try {
    if (compareVersions(engineVersion, extMinVersion) < 0) {
      return {
        compatible: false,
        reason: `Requires engine >= ${extMinVersion}, current is ${engineVersion}`,
      };
    }
    if (extMaxVersion && compareVersions(engineVersion, extMaxVersion) > 0) {
      return {
        compatible: false,
        reason: `Requires engine <= ${extMaxVersion}, current is ${engineVersion}`,
      };
    }
  } catch (err) {
    return { compatible: false, reason: (err as Error).message };
  }

  return { compatible: true };
}

/**
 * Checks that all declared extension dependencies are installed and enabled.
 */
export async function checkExtensionDependencies(
  db: Database,
  dependencies: Array<{ name: string; minVersion?: string }>,
  /**
   * Extensions already loaded in THIS boot.
   *
   * The registry table is the record of what an operator installed through the
   * marketplace. It is not the record of what is running: an install driven by
   * `ZVELTIO_EXTENSIONS` (or a fresh container whose registry has not been
   * populated yet) loads straight from disk and never writes those rows. The
   * check consulted only the table, so a dependency that had *just been loaded
   * a few milliseconds earlier* was reported "not installed" — measured live
   * with `finance/invoicing` loaded and `operations/traceability` refused for
   * needing it. Ten extensions failed to start that way, in dependency chains
   * that were entirely satisfied.
   *
   * Passing the loader's own view fixes the question being asked: not "did
   * someone install this" but "is this available to depend on". Version
   * constraints still fall back to the table, which is the only place a version
   * is recorded.
   */
  alreadyLoaded?: ReadonlySet<string>,
): Promise<{ satisfied: boolean; missing: string[] }> {
  const missing: string[] = [];

  for (const dep of dependencies) {
    // Loaded in this boot: available regardless of what the table says.
    if (alreadyLoaded?.has(dep.name)) continue;

    // No `.catch(() => null)`. It fell into the `missing.push(... not installed)`
    // branch below, so a failed read told an operator a dependency was NOT
    // INSTALLED when the truth was that it could not be checked — and they go and
    // install something that is already there.
    //
    // Letting it throw is safe and says the right thing: `loadExtensionFromDir`
    // wraps this in a per-extension boundary that logs
    // `❌ Failed to load extension "<name>"` and records the database's own error
    // as `lastLoadError`. So this extension still refuses to load, which is the
    // correct direction, and the reason recorded is the read failure rather than
    // a fabricated claim about what is installed. One extension's boot fails, not
    // the boot.
    const installed = await db
      .selectFrom('zv_extension_registry')
      .select(['version', 'is_enabled'])
      .where('name', '=', dep.name)
      .where('is_enabled', '=', true)
      .executeTakeFirst();

    if (!installed) {
      missing.push(`${dep.name} (not installed)`);
      continue;
    }

    if (dep.minVersion) {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const current = (installed as any).version || '0.0.0';
      if (compareVersions(current, dep.minVersion) < 0) {
        missing.push(
          // `version`, not `installed_version`: the query above selects
          // `['version', 'is_enabled']` and nothing else, so the other name read
          // `undefined` on every call and the operator was told
          // "installed: undefined" for every unsatisfied dependency.
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
          `${dep.name} >= ${dep.minVersion} (installed: ${(installed as any).version})`,
        );
      }
    }
  }

  return { satisfied: missing.length === 0, missing };
}

export function getEngineVersion(): string {
  return ENGINE_VERSION;
}

// ── Semver helpers ────────────────────────────────────────────

/** Semver order, prerelease included. Throws `Invalid SemVer: <v>`. */
function compareVersions(a: string, b: string): number {
  return Bun.semver.order(a, b);
}
