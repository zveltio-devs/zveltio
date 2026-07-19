#!/usr/bin/env bun
/** Remove duplicated markup blocks introduced by automated shell wrapping. */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const EXT = join(import.meta.dir, '../../../zveltio-extensions');

const files: { path: string; truncateAfter: string }[] = [
  {
    path: 'hr/time-tracking/studio/pages/+page.svelte',
    truncateAfter: '{/if}\n</div>\n\n{#if showModal}',
  },
  {
    path: 'finance/accounting/studio/pages/+page.svelte',
    truncateAfter: '{/if}\n{#if loading}',
  },
];

for (const { path, truncateAfter } of files) {
  const full = join(EXT, path);
  let c = readFileSync(full, 'utf8');
  const idx = c.indexOf(truncateAfter);
  if (idx < 0) {
    console.log(`[skip] ${path} — marker not found`);
    continue;
  }
  // Keep everything up to and including the first modal block's closing
  const secondStart = c.indexOf(truncateAfter, idx + 1);
  if (secondStart < 0) {
    console.log(`[skip] ${path} — no duplicate`);
    continue;
  }
  // For time-tracking: first block is main; second duplicate starts with {#if loading}
  // For accounting: duplicate starts {#if loading} after account form
  const cut = path.includes('time-tracking')
    ? c.slice(0, c.indexOf('\n{#if loading}', c.indexOf('{#if showModal}')))
    : c.slice(0, c.indexOf('\n{#if loading}', c.indexOf('{#if showAccountForm}')));
  if (cut.length < c.length) {
    writeFileSync(full, cut.trimEnd() + '\n');
    console.log(`[fixed] ${path}: ${c.length} → ${cut.length} chars`);
  }
}
