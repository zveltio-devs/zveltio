#!/usr/bin/env bun
/**
 * Gate: a dependency BUNDLED into a generated artifact is the locked one.
 *
 * Two artifacts inline their dependencies instead of importing them:
 *
 *   packages/engine/src/lib/worker-extension-runtime-source.generated.ts
 *       the worker runtime, embedded as a string because `bun --compile`
 *       does not bundle workers
 *
 *   ../zveltio-extensions/<group>/<name>/engine/index.js
 *       every packed extension — `extension pack` bundles hono, zod, kysely and
 *       @hono/zod-validator into the artifact, because a compiled binary cannot
 *       resolve bare specifiers from on-disk node_modules
 *
 * ── Why this exists ───────────────────────────────────────────
 *
 * On 2026-09-01 hono was raised to 4.13.5, a SECURITY release. The engine got
 * it. Nothing else did:
 *
 *     bun.lock                          4.13.5
 *     worker runtime (generated)        4.13.3
 *     44 extension bundles              4.13.3 — and three on 4.12.28
 *
 * Two versions behind, in artifacts that serve requests. **No gate said
 * anything**, and both freshness gates were green the whole time:
 * `check-worker-source-fresh` hashes `worker-extension-runtime.ts` and
 * `check-bundle-sources` hashes each extension's TypeScript. Both are correct
 * for what they were written to catch — a source edit nobody rebuilt — and both
 * are blind to a dependency bump, because a bump changes no source.
 *
 * So the class is: **a security fix in a bundled dependency reaches nothing
 * that bundles it, and nothing notices.** That is what this closes.
 *
 * ── How ───────────────────────────────────────────────────────
 *
 * Bun's bundler leaves the resolved path in a comment above each inlined
 * module — `// ../../node_modules/.bun/hono@4.13.5/node_modules/hono/dist/…` —
 * so the version that actually went in is readable from the artifact itself.
 * That is the point: this reads what SHIPPED, not what a manifest claims.
 *
 * Usage: bun run scripts/check-embedded-deps-fresh.ts [--report]
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const LOCK = join(ROOT, 'bun.lock');
const WORKER_GEN = join(
  ROOT,
  'packages/engine/src/lib/worker-extension-runtime-source.generated.ts',
);
const EXT_ROOT = join(ROOT, '..', 'zveltio-extensions');
const REPORT_ONLY = process.argv.includes('--report');

/**
 * Only what `extension pack` actually bundles.
 *
 * Deliberately not "every package that appears": a bundle also inlines whatever
 * those four drag in, and holding a transitive dependency to the engine's lock
 * would fail for a version nobody chose. These four are the ones the packer
 * names, and the ones whose types cross the boundary.
 */
const BUNDLED = ['hono', 'zod', 'kysely', '@hono/zod-validator'];

/** `name@1.2.3` as the bundler leaves it in its resolved-path comments. */
const EMBEDDED = /(?:\.bun\/)((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+)/g;

function embeddedVersions(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of text.matchAll(EMBEDDED)) {
    const [, name, version] = m;
    if (!BUNDLED.includes(name!)) continue;
    if (!out.has(name!)) out.set(name!, new Set());
    out.get(name!)!.add(version!);
  }
  return out;
}

/** What the engine's lockfile resolved, for the packages we care about. */
function lockedVersions(lock: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of BUNDLED) {
    // `"hono": ["hono@4.13.5", …]` — the top-level entry, not a nested one.
    const re = new RegExp(
      `\\n {4}"${name.replace('/', '\\/')}": \\["${name.replace('/', '\\/')}@(\\d+\\.\\d+\\.\\d+)"`,
    );
    const m = re.exec(lock);
    if (m) out.set(name, m[1]!);
  }
  return out;
}

function artifacts(): Array<{ label: string; file: string }> {
  const found: Array<{ label: string; file: string }> = [];
  if (existsSync(WORKER_GEN)) found.push({ label: 'worker runtime', file: WORKER_GEN });
  if (!existsSync(EXT_ROOT)) return found;

  /**
   * Every `.js` under one extension's `engine/`, not just `index.js`: a bundle
   * can be split into chunks, and a chunk ships the same inlined dependency.
   */
  const collect = (dir: string, label: string) => {
    const edir = join(dir, 'engine');
    if (!existsSync(edir) || !statSync(edir).isDirectory()) return;
    for (const f of readdirSync(edir)) {
      if (!f.endsWith('.js')) continue;
      found.push({ label: `${label}${f === 'index.js' ? '' : `/${f}`}`, file: join(edir, f) });
    }
  };

  // Extensions live at BOTH depths — `<group>/<name>` and, for six of them,
  // `<name>` at the top. Walking only `<group>/<name>` is not a style choice, it
  // is a blind spot: the first version of this gate did exactly that, reported
  // "45 artifacts, all current", and had never looked at `ai`, `billing`, `crm`,
  // `forms`, `search` or `sms` — all six still shipping the vulnerable hono the
  // gate exists to catch. A `*/*/` glob in the repack loop had missed the same
  // six minutes earlier, which is how a gate and the work it checks can share
  // one wrong assumption and agree with each other.
  //
  // A `manifest.json` at the directory root is what distinguishes an extension
  // from a group.
  for (const entry of readdirSync(EXT_ROOT)) {
    if (entry.startsWith('.')) continue;
    const dir = join(EXT_ROOT, entry);
    if (!statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, 'manifest.json'))) {
      collect(dir, entry);
      continue;
    }
    for (const name of readdirSync(dir)) {
      const sub = join(dir, name);
      if (!statSync(sub).isDirectory()) continue;
      collect(sub, `${entry}/${name}`);
    }
  }
  return found;
}

const locked = lockedVersions(await Bun.file(LOCK).text());
if (locked.size === 0) {
  console.error('[embedded-deps] parsed no versions from bun.lock — the format changed.');
  process.exit(1);
}

const stale: Array<{ label: string; dep: string; embedded: string; locked: string }> = [];
const checked: string[] = [];

for (const { label, file } of artifacts()) {
  const text = await Bun.file(file).text();
  const embedded = embeddedVersions(text);
  if (embedded.size === 0) continue; // nothing bundled here
  checked.push(label);
  for (const [dep, versions] of embedded) {
    const want = locked.get(dep);
    if (!want) continue;
    for (const got of versions) {
      if (got !== want) stale.push({ label, dep, embedded: got, locked: want });
    }
  }
}

if (REPORT_ONLY) {
  console.log(`[embedded-deps] ${checked.length} artifact(s), ${stale.length} stale\n`);
  for (const s of stale)
    console.log(`  ${s.label.padEnd(30)} ${s.dep}@${s.embedded}  (locked ${s.locked})`);
  process.exit(0);
}

if (stale.length > 0) {
  console.error(
    `\n❌ ${stale.length} artifact(s) ship a dependency older than the lockfile.\n\n` +
      `   These files INLINE their dependencies, so a bump in package.json does not\n` +
      `   reach them — the artifact keeps whatever it was built with. A security fix\n` +
      `   in a bundled dependency therefore reaches nothing that bundles it.\n\n` +
      `   That is not hypothetical: hono 4.13.5 (a security release) landed in the\n` +
      `   engine while 44 extension bundles stayed on 4.13.3, three of them on\n` +
      `   4.12.28, and every freshness gate was green — they hash SOURCE.\n`,
  );
  for (const s of stale) {
    console.error(`  ${s.label.padEnd(30)} ${s.dep}@${s.embedded}   locked: ${s.locked}`);
  }
  console.error(
    `\n  Extensions read from: ${EXT_ROOT}\n` +
      `  If that is a SECOND, older checkout — running from a git worktree resolves\n` +
      `  the sibling relative to THIS repo — the staleness is the checkout's, not the\n` +
      `  code's. That has already cost time once; check the path before rebuilding.`,
  );
  console.error(
    `\n  Rebuild them:\n` +
      `    worker runtime : cd packages/engine && bun scripts/gen-worker-source.ts\n` +
      `    an extension   : bun <cli> extension pack --dir <group>/<name> --first-party\n\n` +
      `  Then bump each repacked extension's manifest version — the registry refuses\n` +
      `  the same version with different bytes.\n\n` +
      `  Verify the artifact, not the command's output:\n` +
      `    grep -ohE "hono@[0-9.]+" */*/engine/index.js | sort -u\n`,
  );
  process.exit(1);
}

console.log(
  `[embedded-deps] OK — ${checked.length} artifact(s), every bundled ` +
    `${BUNDLED.join('/')} matches ${relative(ROOT, LOCK)}` +
    (existsSync(EXT_ROOT) ? ` (extensions: ${EXT_ROOT})` : ' (engine only — sibling absent)'),
);
