import { describe, expect, it, vi } from 'vitest';

/**
 * A rejected clipboard write must be reported, not reported as a success.
 *
 * `writeText` rejects without a secure context or the clipboard permission.
 * Five call sites left that rejection unhandled and showed the "copied" tick
 * anyway — on the API-keys screen over a key that is displayed exactly once.
 */
const { errors } = vi.hoisted(() => ({ errors: [] as string[] }));
vi.mock('$lib/stores/toast.svelte.js', () => ({
  toast: { error: (msg: string) => errors.push(msg), success: vi.fn() },
}));

import { copyText } from './clipboard.js';

function withClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

describe('copyText', () => {
  it('reports a rejected write and answers false', async () => {
    errors.length = 0;
    withClipboard(() => Promise.reject(new Error('NotAllowedError')));
    expect(await copyText('zvk_secret')).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('answers true and stays quiet when the write lands', async () => {
    errors.length = 0;
    const seen: string[] = [];
    withClipboard(async (...args: unknown[]) => {
      seen.push(args[0] as string);
    });
    expect(await copyText('zvk_secret')).toBe(true);
    expect(seen).toEqual(['zvk_secret']);
    expect(errors).toEqual([]);
  });
});
