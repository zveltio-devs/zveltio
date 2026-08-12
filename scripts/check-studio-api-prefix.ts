#!/usr/bin/env bun
/**
 * Studio may not call an extension through `/extensions/`.
 *
 * The engine mounts every extension under `/ext/<name>`. `/extensions/` is not
 * an alias, it is nothing — the router has no such prefix, so the call 404s and
 * the page opens with an error toast over an empty list.
 *
 * `search` and `sms` shipped that way. Both are visible modules with their own
 * navigation entry, and both were dead on arrival for as long as anyone can
 * tell from the code: three panels on the SMS page failed on load, and every
 * index operation on the search page did the same. Nothing failed loudly enough
 * to be noticed, because a 404 inside a fetch becomes a toast and toasts are
 * easy to stop reading.
 *
 * One typo away from returning, and nothing else looks for it. Hence this.
 *
 * Run: `bun run scripts/check-studio-api-prefix.ts`
 */

/**
 * Both trees are checked. `packages/studio/src/routes/(admin)/**` is a
 * generated snapshot — `sync-extensions.ts` copies each extension's
 * `studio/pages/` into it at prebuild — so an edit made only there is silently
 * reverted by the next build. Scanning both means the gate fires whether the
 * mistake was made at the source or in the copy, and the message says which.
 */
const ROOTS = [
  { path: 'packages/studio/src', label: 'Studio' },
  { path: '../zveltio-extensions', label: 'extensions (source of the generated pages)' },
];

/**
 * The literal prefix, nothing clever.
 *
 * The first version of this matched `['"`]/extensions/` — a character class for
 * the opening quote — and the escaping needed to carry that through a shell
 * argument mangled it into a pattern that matched nothing. The gate reported
 * OK against a file that had the defect reintroduced on purpose.
 *
 * A guard that cannot fail is worse than none: it converts an unchecked area
 * into one that looks checked. The string is distinctive on its own.
 */
const PATTERN = '/extensions/';

interface Hit {
  root: string;
  file: string;
  line: number;
  text: string;
}

const hits: Hit[] = [];

/**
 * Walked in JavaScript rather than shelled out to grep.
 *
 * The first version ran `grep --include=*.svelte` through Bun's shell, which
 * expands the glob itself before grep ever sees it — against the wrong
 * directory, so it matched nothing and the gate passed over a file with the
 * defect deliberately put back. Reading the files directly has no quoting layer
 * to get wrong.
 */
const EXTS = ['.svelte', '.ts', '.js'];

for (const root of ROOTS) {
  const exists = await Bun.file(`${root.path}/package.json`).exists();
  if (!exists && root.path.startsWith('..')) {
    // The extensions checkout is a sibling and may not be present — in a
    // release build, for instance. Skipping is correct; failing would tie the
    // gate to the layout of whoever runs it.
    console.log(`[studio-api-prefix] ·  ${root.label} not present — skipped.`);
    continue;
  }

  const glob = new Bun.Glob('**/*');
  for await (const rel of glob.scan({ cwd: root.path, onlyFiles: true })) {
    if (!EXTS.some((e) => rel.endsWith(e))) continue;
    if (rel.includes('node_modules/') || rel.includes('dist/')) continue;
    // Only Studio-facing code. An extension's ENGINE may legitimately serve a
    // route called `/extensions/:name/enable` — `developer/database` does — and
    // flagging that would be the gate misreading its own subject. The rule is
    // about what Studio CALLS, so only pages count.
    if (root.path.startsWith('..') && !rel.includes('/studio/')) continue;

    const full = `${root.path}/${rel}`;
    const text = await Bun.file(full).text();
    if (!text.includes(PATTERN)) continue;

    text.split('\n').forEach((line, i) => {
      if (line.includes(PATTERN)) {
        hits.push({ root: root.label, file: full, line: i + 1, text: line.trim() });
      }
    });
  }
}

if (hits.length === 0) {
  console.log('[studio-api-prefix] OK — no Studio call uses the /extensions/ prefix.');
  process.exit(0);
}

console.error(
  `[studio-api-prefix] FAIL — ${hits.length} call(s) use a prefix the engine does not serve:\n`,
);
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}  [${h.root}]`);
  console.error(`    ${h.text.slice(0, 120)}`);
}
console.error(
  `\nThe engine mounts extensions at /ext/<name>. Replace /extensions/ with /ext/.\n` +
    `If the file lives under packages/studio/src/routes/(admin)/, it is GENERATED —\n` +
    `fix it in zveltio-extensions/<ext>/studio/pages/ instead, or the next build\n` +
    `overwrites the fix and the defect returns without a commit.\n`,
);
process.exit(1);
