#!/usr/bin/env bun
/**
 * Generate the SDK's copy of the shared Studio message vocabulary.
 *
 * Why this exists:
 *
 *   `zveltio extension validate` checks that every user-visible string in an
 *   SDUI schema resolves to a real message key. It runs in the extension
 *   author's repository, where the Studio's catalogue does not exist — so the
 *   shared part of that catalogue has to travel with the SDK.
 *
 *   Only `common.*` and `ext.*` are shared. They are the deliberately generic
 *   vocabulary (Save, Cancel, Status, "Delete {name}?") that every extension
 *   reuses. Everything else in the core catalogue belongs to a specific core
 *   page; an extension reaching for `insights.title` is coupling itself to a
 *   page it does not own, and the validator should say so.
 *
 * Run: bun run scripts/sync-shared-message-keys.ts [--check]
 *   --check exits 1 on drift instead of writing (used by the CI gate).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SOURCE = join(ROOT, 'packages/studio/messages/core/en.json');
const TARGET = join(ROOT, 'packages/sdk/src/validate/shared-message-keys.ts');

/** Namespaces an extension may legitimately borrow from the host. */
const SHARED_PREFIXES = ['common.', 'ext.'];

const core = JSON.parse(readFileSync(SOURCE, 'utf-8')) as Record<string, string>;
const keys = Object.keys(core)
  .filter((k) => SHARED_PREFIXES.some((p) => k.startsWith(p)))
  .sort();

const body = `/**
 * GENERATED — do not edit. Run \`bun run scripts/sync-shared-message-keys.ts\`.
 *
 * The subset of the Studio's core message catalogue that extensions may use
 * in SDUI schemas without shipping the key themselves: the generic vocabulary
 * (\`common.*\`) plus the shared extension helpers (\`ext.*\`).
 *
 * An extension that needs anything else must ship it in its own
 * \`studio/messages/{locale}.json\` — otherwise it renders correctly only on a
 * host whose core catalogue happens to know about it, which is not a property
 * an installable extension should depend on.
 *
 * Source: packages/studio/messages/core/en.json (${keys.length} keys)
 */
export const SHARED_MESSAGE_KEYS: ReadonlySet<string> = new Set([
${keys.map((k) => `  '${k.replace(/'/g, "\\'")}',`).join('\n')}
]);
`;

if (process.argv.includes('--check')) {
  const current = readFileSync(TARGET, 'utf-8');
  if (current !== body) {
    console.error(
      '❌ shared-message-keys drift: packages/sdk/src/validate/shared-message-keys.ts is stale.\n' +
        '   The Studio core catalogue changed. Run:\n' +
        '     bun run scripts/sync-shared-message-keys.ts\n',
    );
    process.exit(1);
  }
  console.log(`✅ shared-message-keys: in sync (${keys.length} keys).`);
  process.exit(0);
}

writeFileSync(TARGET, body);
console.log(
  `✅ shared-message-keys: wrote ${keys.length} keys to ${TARGET.slice(ROOT.length + 1)}`,
);
