/**
 * `promptHidden` reads piped input as well as typed: `create-god` asks for the
 * password twice, and a pipe delivers both lines in one chunk. The second
 * prompt used to wait forever for input that had already arrived, and the
 * visible prompts (readline) swallowed the lines meant for the hidden ones.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

const script = `
import { promptHidden, promptLine } from ${JSON.stringify(join(import.meta.dir, 'prompt.ts'))};
const a = await promptLine('A: ');
const b = await promptHidden('B: ').catch((e) => 'ERR ' + e.message);
console.log(JSON.stringify([a, b]));
`;

async function piped(input: string): Promise<unknown> {
  const proc = Bun.spawn(['bun', '-e', script], {
    stdin: new TextEncoder().encode(input),
    stdout: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), 10_000);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

describe('promptHidden on a pipe', () => {
  it('takes one line per prompt from a single chunk', async () => {
    expect(await piped('pw1\npw2\n')).toEqual(['pw1', 'pw2']);
    expect(await piped('x\r\ny\r\n')).toEqual(['x', 'y']);
    // The last line need not end in a newline.
    expect(await piped('pw1\npw2')).toEqual(['pw1', 'pw2']);
  });

  it('refuses when the input ends before the second line', async () => {
    expect(await piped('only\n')).toEqual(['only', 'ERR input ended before a value was given']);
  });
});
