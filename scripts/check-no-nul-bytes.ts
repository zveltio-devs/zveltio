#!/usr/bin/env bun
/**
 * No tracked source file may contain a NUL byte.
 *
 * Not a style rule. `grep` decides a file is binary the moment it sees one, and
 * then it SKIPS that file in silence: no match, no warning, exit status 1 —
 * indistinguishable from "this file contains nothing you asked about".
 *
 *   const k = "a\0b";              // written as a literal NUL, not as \0
 *   grep -c zv_settings <file>     ->  prints nothing, exits 1
 *   grep -ac zv_settings <file>    ->  1
 *
 * This campaign is largely grep-shaped. The sweeps behind `selectFrom('user')`,
 * the `::jsonb` cast class, the `.catch(() => {})` inventory and the unique-key
 * campaign were all searches across the tree, and every one of them would have
 * reported such a file clean without ever opening it — while producing a count
 * that reads like a total.
 *
 * Found in the sibling repository, where one Map-key separator had been written
 * as the character rather than the escape, inside the third-largest file there.
 * This engine's tree is clean today; the gate is what keeps the next one from
 * quietly voiding a measurement nobody re-runs.
 *
 * The engine's own gates read files with `readFileSync` rather than shelling out
 * to `grep`, so they are immune by construction. This protects the ad-hoc
 * searching that a review session does by hand, which is where the numbers in
 * the reports come from.
 *
 * Run: `bun run scripts/check-no-nul-bytes.ts`
 */

import { readFileSync } from 'node:fs';

/** Files that are binary on purpose. Everything else must be text. */
const BINARY =
  /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|br|wasm|mp4|webm|mp3|wav|bin|node)$/i;

const tracked = Bun.spawnSync(['git', 'ls-files', '-z'])
  .stdout.toString()
  .split('\0')
  .filter(Boolean);

const offenders: string[] = [];
let scanned = 0;

for (const file of tracked) {
  if (BINARY.test(file)) continue;
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    continue; // deleted in the working tree, or a submodule entry
  }
  scanned++;
  const at = bytes.indexOf(0);
  if (at === -1) continue;
  // Report the LINE, because "somewhere in 1658 lines" is not actionable.
  const line = bytes.subarray(0, at).toString('utf8').split('\n').length;
  offenders.push(`${file}:${line}`);
}

if (offenders.length > 0) {
  console.error('[no-nul-bytes] FAIL — a tracked source file contains a NUL byte:\n');
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    '\ngrep treats such a file as binary and skips it silently — no match, exit 1,\n' +
      'which reads exactly like "nothing here". Every repository-wide search that\n' +
      'touched it has been reporting it clean without opening it.\n\n' +
      'Write the escape (\\0) instead of the character. `grep -a` will show you what\n' +
      'the file really holds in the meantime.',
  );
  process.exit(1);
}

console.log(`[no-nul-bytes] OK — ${scanned} tracked text files, none binary to grep.`);
