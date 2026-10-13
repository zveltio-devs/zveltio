/**
 * splitFetchLines keeps at most `maxKept` characters of stdout: a function that
 * prints without end (or never prints a newline) cannot grow engine memory.
 */

import { describe, expect, it } from 'bun:test';
import { splitFetchLines } from '../../lib/edge-functions/egress.js';

const stream = (...chunks: string[]) =>
  new Response(chunks.join('')).body as ReadableStream<Uint8Array>;

describe('splitFetchLines stdout cap', () => {
  it('keeps lines under the cap and marks the rest truncated', async () => {
    const out = await splitFetchLines(
      stream('{"ok":true}\n', `${'x'.repeat(50)}\n`),
      null,
      100,
      20,
    );
    expect(out).toBe('{"ok":true}\n[edge] stdout truncated at 20 characters');
  });

  it('drops a newline-less line past the cap', async () => {
    const out = await splitFetchLines(stream('y'.repeat(500)), null, 100, 20);
    expect(out.length).toBeLessThan(100);
    expect(out).toContain('truncated');
  });

  it('is unchanged under the cap', async () => {
    expect(await splitFetchLines(stream('a\nb\n'), null)).toBe('a\nb');
  });
});
