import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

// The watchdog writes to stderr from its own thread while the main thread is
// blocked, so the proof runs in a child process and reads that stderr.
describe('inline-lag watchdog (ADR 0056 d2)', () => {
  it('names the inline action that blocks the event loop', async () => {
    const mod = join(import.meta.dir, '../../lib/extensions/inline-lag.ts');
    const script = `
      const { attributed, STALL_MS } = await import(${JSON.stringify(mod)});
      await attributed('acme/spin', async () => {
        const end = Date.now() + STALL_MS + 1000;
        while (Date.now() < end) {}
      });
    `;
    const proc = Bun.spawn(['bun', '-e', script], { stderr: 'pipe', stdout: 'ignore' });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    const line = JSON.parse(
      stderr.split('\n').find((l) => l.includes('event loop blocked')) ?? 'null',
    );
    expect(line?.inlineActions).toEqual(['acme/spin']);
    expect(line?.blockedMs).toBeGreaterThanOrEqual(2000);
  }, 15_000);
});
