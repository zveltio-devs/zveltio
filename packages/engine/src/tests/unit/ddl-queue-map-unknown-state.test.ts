/**
 * mapJobToPublic — unknown pg-boss state defaults to pending (ddl-queue.ts).
 */

import { describe, expect, it } from 'bun:test';
import { _internalForTests } from '../../lib/data/ddl-queue.js';

const { mapJobToPublic } = _internalForTests;

describe('mapJobToPublic — unknown state', () => {
  it('defaults unrecognized pg-boss states to pending', () => {
    const out = mapJobToPublic(
      {
        id: 'u1',
        state: 'archived',
        data: { name: 'x' },
        retrycount: 0,
        retrylimit: 3,
        createdon: '2026-07-12T00:00:00Z',
      },
      'create_collection' as never,
    );
    expect(out.status).toBe('pending');
  });

  it('extracts error from output.error when message is absent', () => {
    const out = mapJobToPublic(
      {
        id: 'f3',
        state: 'failed',
        data: {},
        retrycount: 1,
        retrylimit: 3,
        createdon: '2026-07-12T00:00:00Z',
        output: { error: 'ddl exploded' },
      },
      'add_field' as never,
    );
    expect(out.error).toBeNull();
    expect(out.status).toBe('failed');
  });
});
