/**
 * flow-executor.ts — webhook step strips blocked credential-injection headers.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const { _internalForTests } = await import('../../lib/flows/flow-executor.js');
const { executeStep } = _internalForTests;

describe('executeStep — webhook blocked headers', () => {
  let originalFetch: typeof fetch;
  let warnSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  it('drops Authorization from custom headers and warns', async () => {
    originalFetch = globalThis.fetch;
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

    const { output } = await executeStep(
      new CannedDb().kysely as unknown as Database,
      {
        type: 'webhook',
        config: {
          url: 'https://example.com/hooks/flow',
          method: 'POST',
          headers: { Authorization: 'Bearer stolen', 'X-Custom': 'ok' },
          body: { ok: true },
        },
      },
      {},
      {},
    );

    expect(output.ok).toBe(true);
    expect(warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('Blocked header'))).toBe(
      true,
    );
  });
});
