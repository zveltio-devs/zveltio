import type { Database } from '../db/index.js';
import { ENGINE_VERSION } from '../version.js';

/**
 * Checks compatibility of an extension with the current engine version.
 * Uses simple semver: major.minor.patch
 */
export function isCompatible(
  engineVersion: string,
  extMinVersion?: string | null,
  extMaxVersion?: string | null,
): { compatible: boolean; reason?: string } {
  if (!extMinVersion) return { compatible: true };

  const engine = parseSemver(engineVersion);
  const min = parseSemver(extMinVersion);

  if (compareSemver(engine, min) < 0) {
    return {
      compatible: false,
      reason: `Requires engine >= ${extMinVersion}, current is ${engineVersion}`,
    };
  }

  if (extMaxVersion) {
    const max = parseSemver(extMaxVersion);
    if (compareSemver(engine, max) > 0) {
      return {
        compatible: false,
        reason: `Requires engine <= ${extMaxVersion}, current is ${engineVersion}`,
      };
    }
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const current = parseSemver((installed as any).version || '0.0.0');
      const required = parseSemver(dep.minVersion);
      if (compareSemver(current, required) < 0) {
        missing.push(
          `${dep.name} >= ${dep.minVersion} (installed: ${
            // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
            (installed as any).installed_version
          })`,
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

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(v: string): SemVer {
  const [major = 0, minor = 0, patch = 0] = v.replace(/^v/, '').split('.').map(Number);
  return { major, minor, patch };
}

function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}
