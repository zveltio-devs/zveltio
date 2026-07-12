/**
 * mapJobToPublic — failed, cancelled, expired, dlq states (ddl-queue.ts).
 */

import { describe, expect, it } from 'bun:test';
import { _internalForTests } from '../../lib/data/ddl-queue.js';

const { mapJobToPublic } = _internalForTests;

describe('mapJobToPublic — terminal failure states', () => {
  it('maps failed state with output message', () => {
    const out = mapJobToPublic(
      {
        id: 'f1',
        state: 'failed',
        data: { name: 'widgets' },
        retrycount: 3,
        retrylimit: 3,
        createdon: '2026-07-12T00:00:00Z',
        output: { message: 'ddl failed hard' },
      },
      'drop_collection' as never,
    );
    expect(out.status).toBe('failed');
    expect(out.error).toBe('ddl failed hard');
    expect(out.retry_count).toBe(3);
  });

  it('maps cancelled and expired to failed status', () => {
    const cancelled = mapJobToPublic(
      {
        id: 'c1',
        state: 'cancelled',
        data: {},
        retrycount: 0,
        retrylimit: 3,
        createdon: '2026-07-12T00:00:00Z',
      },
      'add_field' as never,
    );
    expect(cancelled.status).toBe('failed');

    const expired = mapJobToPublic(
      {
        id: 'e1',
        state: 'expired',
        data: {},
        retrycount: 2,
        retrylimit: 3,
        createdon: '2026-07-12T00:00:00Z',
      },
      'remove_field' as never,
    );
    expect(expired.status).toBe('failed');
  });
});
