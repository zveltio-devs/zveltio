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
): Promise<{ satisfied: boolean; missing: string[] }> {
  const missing: string[] = [];

  for (const dep of dependencies) {
    const installed = await (db as any)
      .selectFrom('zv_extension_registry')
      .select(['installed_version', 'is_enabled'])
      .where('name', '=', dep.name)
      .where('is_enabled', '=', true)
      .executeTakeFirst()
      .catch(() => null);

    if (!installed) {
      missing.push(`${dep.name} (not installed)`);
      continue;
    }

    if (dep.minVersion) {
      const current = parseSemver((installed as any).installed_version || '0.0.0');
      const required = parseSemver(dep.minVersion);
      if (compareSemver(current, required) < 0) {
        missing.push(`${dep.name} >= ${dep.minVersion} (installed: ${(installed as any).installed_version})`);
      }
    }
  }

  return { satisfied: missing.length === 0, missing };
}

export function getEngineVersion(): string {
  return ENGINE_VERSION;
}

// ── Semver helpers ────────────────────────────────────────────

interface SemVer { major: number; minor: number; patch: number }

function parseSemver(v: string): SemVer {
  const [major = 0, minor = 0, patch = 0] = v.replace(/^v/, '').split('.').map(Number);
  return { major, minor, patch };
}

function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}
