/**
 * Extension discovery + dependency ordering for `ExtensionLoader` (H-04 split).
 *
 * Pure, loader-state-free helpers: read the `ZVELTIO_EXTENSIONS` env list,
 * enumerate an external extensions directory, and topologically sort a set of
 * extension names by their manifest `dependencies`. Extracted out of the loader
 * class; `topoSortExtensions` is re-exposed as a thin delegator method because
 * `registerMarketplaceRoutes` calls it via the loader instance. Every
 * `console.*` string, error message, and ordering rule is byte-identical to the
 * pre-split methods — zero behaviour change.
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'path';

/**
 * Read manifest.dependencies for each extension and topologically sort.
 *
 * Behavior:
 *   - Extensions with no manifest or no dependencies retain their relative order.
 *   - If a declared dependency is not in the planned-for-load set, the dependent
 *     extension is skipped with a warning (it can be loaded later via loadFromDB).
 *   - A cycle is refused, not thrown: its members, and whatever depends on one,
 *     are left out of the result and named in `refused` with the reason. A throw
 *     here took every other extension in the batch down with the cycle.
 *
 * @param names    Extension names planned for load.
 * @param baseDir  Base directory where extensions live (manifests are read from here).
 * @param refused  Filled with name → reason for every extension left out.
 */
export async function topoSortExtensions(
  names: string[],
  baseDir: string,
  refused: Map<string, string> = new Map(),
): Promise<string[]> {
  if (names.length <= 1) return names;

  const depsMap = new Map<string, string[]>();
  for (const name of names) {
    const manifestPath = join(baseDir, name, 'manifest.json');
    let deps: string[] = [];
    if (existsSync(manifestPath)) {
      try {
        const m = JSON.parse(await Bun.file(manifestPath).text()) as {
          dependencies?: Array<{ name: string }>;
        };
        deps = (m.dependencies ?? []).map((d) => d.name);
      } catch {
        /* ignore — extension will fail later in loadExtension with proper error */
      }
    }
    depsMap.set(name, deps);
  }

  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  /** False when `name` is refused. */
  const visit = (name: string, path: string[]): boolean => {
    if (refused.has(name)) return false;
    if (visited.has(name)) return true;
    if (visiting.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name];
      const reason = `Circular extension dependency: ${cycle.join(' -> ')}`;
      for (const n of cycle) refused.set(n, reason);
      return false;
    }
    visiting.add(name);
    for (const dep of depsMap.get(name) ?? []) {
      if (!depsMap.has(dep)) {
        console.warn(
          `[extensions] "${name}" depends on "${dep}" which is not in the load set — "${name}" will load anyway, but ctx.services.get('${dep}.*') may return null until "${dep}" is also activated.`,
        );
        continue;
      }
      if (!visit(dep, [...path, name]) && !refused.has(name)) {
        refused.set(name, `depends on "${dep}", which is refused (${refused.get(dep)})`);
      }
    }
    visiting.delete(name);
    if (refused.has(name)) return false;
    visited.add(name);
    sorted.push(name);
    return true;
  };

  for (const name of names) visit(name, []);
  return sorted;
}

export function getActiveExtensionNames(): string[] {
  const envExtensions = process.env.ZVELTIO_EXTENSIONS || '';
  return envExtensions
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

export async function discoverExternal(basePath: string): Promise<string[]> {
  try {
    const entries = await readdir(basePath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
