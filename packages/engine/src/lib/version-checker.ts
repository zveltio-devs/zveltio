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
 * Checks that every declared extension dependency is available and new enough.
 *
 * `missing` is the operator-facing reason per unmet dependency; `tooOld` names
 * the ones that are there but below their `minVersion` (or whose version cannot
 * be told). Required dependencies refuse the dependent on either; an optional
 * one in `tooOld` is treated as absent (see `resolveManifest`).
 */
export async function checkExtensionDependencies(
  db: Database,
  dependencies: Array<{ name: string; minVersion?: string }>,
  /**
   * Extensions already loaded in THIS boot, with the version each loaded at.
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
   * someone install this" but "is this available to depend on". It used to be a
   * set of names, and a loaded dependency skipped the check whole — `minVersion`
   * included, so a dependency loaded at 1.0.0 satisfied `minVersion: "2.0.0"`.
   * The version it loaded at is the one answering calls, so that is the one held
   * to `minVersion`; the table is read only when the loader does not know it.
   */
  alreadyLoaded?: ReadonlyMap<string, string | undefined>,
): Promise<{ satisfied: boolean; missing: string[]; tooOld: string[] }> {
  const missing: string[] = [];
  const tooOld: string[] = [];

  for (const dep of dependencies) {
    const loaded = alreadyLoaded?.has(dep.name) === true;
    // Loaded in this boot and no version to meet: available whatever the table says.
    if (loaded && !dep.minVersion) continue;

    let version = alreadyLoaded?.get(dep.name);
    if (version === undefined) {
      // No `.catch(() => null)`. It fell into the "not installed" branch below,
      // so a failed read told an operator a dependency was NOT INSTALLED when
      // the truth was that it could not be checked — and they go and install
      // something that is already there.
      //
      // Letting it throw is safe and says the right thing: `loadExtensionFromDir`
      // wraps this in a per-extension boundary that logs
      // `❌ Failed to load extension "<name>"` and records the database's own
      // error as `lastLoadError`. So this extension still refuses to load, which
      // is the correct direction, and the reason recorded is the read failure
      // rather than a fabricated claim about what is installed. One extension's
      // boot fails, not the boot.
      const installed = await db
        .selectFrom('zv_extension_registry')
        .select(['version', 'is_enabled'])
        .where('name', '=', dep.name)
        .where('is_enabled', '=', true)
        .executeTakeFirst();
      if (!installed && !loaded) {
        missing.push(`${dep.name} (not installed)`);
        continue;
      }
      version = installed?.version ?? undefined;
    }

    // A version nobody recorded cannot be shown to meet the minimum.
    if (dep.minVersion && (!version || compareVersions(version, dep.minVersion) < 0)) {
      missing.push(`${dep.name} >= ${dep.minVersion} (installed: ${version ?? 'unknown'})`);
      tooOld.push(dep.name);
    }
  }

  return { satisfied: missing.length === 0, missing, tooOld };
}

export function getEngineVersion(): string {
  return ENGINE_VERSION;
}

// ── Semver helpers ────────────────────────────────────────────

/** Semver order, prerelease included. Throws `Invalid SemVer: <v>`. */
function compareVersions(a: string, b: string): number {
  return Bun.semver.order(a, b);
}
