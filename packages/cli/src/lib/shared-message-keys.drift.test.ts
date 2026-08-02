import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHARED_MESSAGE_KEYS } from '@zveltio/sdk/validate';

/**
 * The Studio's core catalogue is the canonical owner of the shared message
 * vocabulary. The SDK ships a generated copy so `zveltio extension validate`
 * can check schema keys in the author's repository, where the Studio does not
 * exist.
 *
 * Without this guard the copy rots silently: a key added to `common.*` would
 * be rejected by `validate` as unknown, and a key removed would keep passing.
 * Regenerate with `bun run scripts/sync-shared-message-keys.ts`.
 */
function readCoreShared(): string[] {
  const path = join(import.meta.dir, '..', '..', '..', 'studio', 'messages', 'core', 'en.json');
  const core = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  return Object.keys(core)
    .filter((k) => k.startsWith('common.') || k.startsWith('ext.'))
    .sort();
}

describe('shared message keys drift (SDK ↔ Studio core catalogue)', () => {
  it('the SDK copy matches common.* + ext.* exactly', () => {
    const core = readCoreShared();
    expect(core.length).toBeGreaterThan(0); // guards against a bad path
    expect([...SHARED_MESSAGE_KEYS].sort()).toEqual(core);
  });
});
