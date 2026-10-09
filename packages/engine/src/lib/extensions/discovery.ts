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
 *   - An `optionalDependencies` entry in the load set is ordered first too; one
 *     not in it is ignored, and one that is refused does not refuse this one.
 *   - Order is depth-first in input order: each extension follows its
 *     dependencies; extensions that do not depend on each other keep their
 *     relative order.
 *   - A required dependency that is not in `names` cannot be ordered: it is
 *     ignored with a warning and the dependent stays in the result. Whether the
 *     dependent then loads is the load-time check's call
 *     (`checkExtensionDependencies`): yes if the dependency is already loaded or
 *     enabled in the registry, refused otherwise. Boot passes ZVELTIO_EXTENSIONS
 *     and the registry's enabled rows as one set, so at boot this only happens
 *     for a dependency that is not enabled anywhere.
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
  const optionalMap = new Map<string, string[]>();
  for (const name of names) {
    const manifestPath = join(baseDir, name, 'manifest.json');
    let deps: string[] = [];
    let optional: string[] = [];
    if (existsSync(manifestPath)) {
      try {
        const m = JSON.parse(await Bun.file(manifestPath).text()) as {
          dependencies?: Array<{ name: string }>;
          optionalDependencies?: Array<{ name: string }>;
        };
        deps = (m.dependencies ?? []).map((d) => d.name);
        optional = (m.optionalDependencies ?? []).map((d) => d.name);
      } catch {
        /* ignore — extension will fail later in loadExtension with proper error */
      }
    }
    depsMap.set(name, deps);
    optionalMap.set(name, optional);
  }

  // An optional dependency in the load set loads first — unless that would close
  // a cycle, in which case it is the edge given up: two extensions that each
  // integrate with the other must both still load. Required edges go in first,
  // so a cycle left in the graph is made of required edges only.
  const reaches = (from: string, to: string): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(depsMap.get(n) ?? []));
    }
    return false;
  };
  const optionalEdges = new Set<string>();
  for (const [name, optional] of optionalMap) {
    for (const dep of optional) {
      const deps = depsMap.get(name) ?? [];
      if (!depsMap.has(dep) || deps.includes(dep) || reaches(dep, name)) continue;
      deps.push(dep);
      optionalEdges.add(`${name}\0${dep}`);
    }
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
          `[extensions] "${name}" depends on "${dep}", which is not in this load set — not ordered; "${name}" loads only if "${dep}" is already loaded or enabled in the registry.`,
        );
        continue;
      }
      // A refused optional dependency is one this extension loads without.
      const optionalEdge = optionalEdges.has(`${name}\0${dep}`);
      if (!visit(dep, [...path, name]) && !optionalEdge && !refused.has(name)) {
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
