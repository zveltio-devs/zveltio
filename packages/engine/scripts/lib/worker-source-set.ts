/**
 * Every LOCAL source file that ends up inside the embedded worker runtime.
 *
 * The bundle inlines the entry module AND everything it imports — seventeen
 * files, not one. `check-worker-source-fresh.ts` hashed only the entry, so an
 * edit to any of the other sixteen left the gate green while the embedded
 * runtime kept the old code. It did: `url-validator.ts` gained the pinned
 * address that closes the DNS-rebinding race in #544, and the worker runtime
 * has been spawning the version that returns nothing ever since.
 *
 * Imports are followed textually rather than through the bundler, because the
 * bundler's own output carries the paths it was built from and those depend on
 * the working directory — the reason the original gate hashed its input in the
 * first place.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** Sorted, repo-relative paths of the entry module and every local import. */
export function workerSourceSet(entry: string, root: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    let src: string;
    try {
      src = readFileSync(file, 'utf-8');
    } catch {
      // A specifier that does not resolve to a file on disk — a directory
      // import, or a path this regex read wrong. Skipping it is safe: it
      // contributes nothing to the hash either way, and the bundler would have
      // failed loudly at generation time if it mattered.
      continue;
    }
    seen.add(file);
    for (const m of src.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      stack.push(join(dirname(file), m[1]!.replace(/\.js$/, '.ts')));
    }
  }
  return [...seen].map((f) => relative(root, f)).sort();
}

/** One hash over that whole set — paths included, so a rename is a change. */
export function hashWorkerSources(files: string[], root: string): string {
  const h = new Bun.CryptoHasher('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update(readFileSync(join(root, rel), 'utf-8'));
  }
  return h.digest('hex');
}
