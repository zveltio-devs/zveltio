/**
 * Fail `i18n:compile` when Paraglide emitted fewer messages than the source has.
 *
 * `paraglide-js compile` imports its message-format plugin from a CDN. When that
 * import fails it warns, prints "Successfully compiled", exits 0 and writes a
 * message index with nothing in it — so every `m[…]()` throws at runtime.
 * Measured with the CDN unreachable: a 95-byte index and 74 Studio tests red,
 * from a step that reported success.
 */
import { join } from 'node:path';
import { missingMessageKeys } from './lib/paraglide-output.ts';

const root = join(import.meta.dir, '..');
const source = (await Bun.file(join(root, 'messages/core/en.json')).json()) as Record<
  string,
  unknown
>;
const compiled = await import(join(root, 'src/lib/paraglide/messages/_index.js'));
const missing = missingMessageKeys(Object.keys(source), compiled);

if (missing.length > 0) {
  console.error(
    `✗ paraglide compiled ${Object.keys(source).length - missing.length} of ` +
      `${Object.keys(source).length} core messages; missing e.g. ${missing.slice(0, 5).join(', ')}. ` +
      'The message-format plugin probably failed to load — see the warning above.',
  );
  process.exit(1);
}
console.log(`✓ paraglide output carries all ${Object.keys(source).length} core messages`);
