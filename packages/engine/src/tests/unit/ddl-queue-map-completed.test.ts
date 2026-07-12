/**
 * mapJobToPublic — completed and running pg-boss states (ddl-queue.ts).
 */

import { describe, expect, it } from 'bun:test';
import { _internalForTests } from '../../lib/data/ddl-queue.js';

const { mapJobToPublic } = _internalForTests;

describe('mapJobToPublic — completed and running', () => {
  it('maps completed state with timestamps', () => {
    const out = mapJobToPublic(
      {
        id: 'c1',
        state: 'completed',
        data: { name: 'widgets' },
        retrycount: 0,
        retrylimit: 3,
        createdon: '2026-07-12T00:00:00Z',
        completedOn: '2026-07-12T00:00:05Z',
        startedOn: '2026-07-12T00:00:01Z',
      },
      'create_collection' as never,
    );
    expect(out.status).toBe('completed');
    expect(out.completed_at).toBeInstanceOf(Date);
    expect(out.started_at).toBeInstanceOf(Date);
    expect(out.type).toBe('create_collection');
  });

  it('maps active state to running', () => {
    const out = mapJobToPublic(
      {
        id: 'r1',
        state: 'active',
        data: {},
        retrycount: 0,
        retrylimit: 3,
        createdon: '2026-07-12T00:00:00Z',
        startedOn: '2026-07-12T00:00:01Z',
      },
      'add_field' as never,
    );
    expect(out.status).toBe('running');
    expect(out.error).toBeNull();
  });
});
