import { describe, it, expect } from 'bun:test';
import { _internalForTests } from '../../lib/data/ddl-queue.js';

/**
 * S5-04 unit tests — pure logic in the new pg-boss-backed DDL queue.
 *
 * pg-boss runs against a real Postgres so the queue itself can only be
 * tested via the engine's integration suite (collections.integration.test.ts
 * etc.). Here we pin the parts that don't need a live DB:
 *
 *   - `mapJobToPublic` translates pg-boss's internal job shape into the
 *     Studio-facing `{ id, type, payload, status, retry_count, ... }` shape.
 *     The HTTP API documented in `routes/collections.ts` depends on this
 *     mapping being stable.
 *   - QUEUE_NAMES exposes the per-type queue strings.
 */

const { mapJobToPublic, QUEUE_NAMES } = _internalForTests;

describe('S5-04 ddl-queue: mapJobToPublic', () => {
  it('translates pg-boss "created" state to "pending"', () => {
    const out = mapJobToPublic(
      {
        id: 'abc-1',
        state: 'created',
        data: { name: 'contacts' },
        retrycount: 0,
        retrylimit: 3,
        createdon: '2026-05-17T00:00:00Z',
      },
      'create_collection' as any,
    );
    expect(out.id).toBe('abc-1');
    expect(out.type).toBe('create_collection');
    expect(out.status).toBe('pending');
    expect(out.payload).toEqual({ name: 'contacts' });
    expect(out.retry_count).toBe(0);
    expect(out.max_retries).toBe(3);
    expect(out.started_at).toBeNull();
    expect(out.completed_at).toBeNull();
    expect(out.error).toBeNull();
  });

  it('maps "retry" → "pending" (transient failure, will be re-tried)', () => {
    const out = mapJobToPublic(
      {
        id: 'r1',
        state: 'retry',
        data: {},
        retrycount: 1,
        retrylimit: 3,
        createdon: '2026-05-17T00:00:00Z',
      },
      'add_field' as any,
    );
    expect(out.status).toBe('pending');
    expect(out.retry_count).toBe(1);
  });

  it('maps "active" → "running" with started_at populated', () => {
    const out = mapJobToPublic(
      {
        id: 'a1',
        state: 'active',
        data: {},
        retrycount: 0,
        retrylimit: 3,
        createdon: '2026-05-17T00:00:00Z',
        startedOn: '2026-05-17T00:01:00Z',
      },
      'remove_field' as any,
    );
    expect(out.status).toBe('running');
    expect(out.started_at).toBeInstanceOf(Date);
    expect(out.started_at?.toISOString()).toBe('2026-05-17T00:01:00.000Z');
  });

  it('maps "completed" → "completed" with both timestamps', () => {
    const out = mapJobToPublic(
      {
        id: 'c1',
        state: 'completed',
        data: {},
        retrycount: 0,
        retrylimit: 3,
        createdon: '2026-05-17T00:00:00Z',
        startedOn: '2026-05-17T00:01:00Z',
        completedOn: '2026-05-17T00:02:00Z',
      },
      'drop_collection' as any,
    );
    expect(out.status).toBe('completed');
    expect(out.completed_at).toBeInstanceOf(Date);
  });

  it('maps "failed" → "failed" and extracts error from output.message', () => {
    const out = mapJobToPublic(
      {
        id: 'f1',
        state: 'failed',
        data: {},
        retrycount: 3,
        retrylimit: 3,
        createdon: '2026-05-17T00:00:00Z',
        output: { message: 'collection already exists' },
      },
      'create_collection' as any,
    );
    expect(out.status).toBe('failed');
    expect(out.error).toBe('collection already exists');
  });

  it('handles string output for legacy compatibility', () => {
    const out = mapJobToPublic(
      {
        id: 'f2',
        state: 'failed',
        data: {},
        retrycount: 0,
        retrylimit: 3,
        createdon: '2026-05-17T00:00:00Z',
        output: 'plain string error',
      },
      'add_field' as any,
    );
    expect(out.error).toBe('plain string error');
  });

  it('maps "cancelled" and "expired" → "failed"', () => {
    const cancelled = mapJobToPublic(
      {
        id: 'x1',
        state: 'cancelled',
        data: {},
        retrycount: 0,
        retrylimit: 3,
        createdon: '2026-05-17T00:00:00Z',
      },
      'drop_relation' as any,
    );
    expect(cancelled.status).toBe('failed');
    const expired = mapJobToPublic(
      {
        id: 'x2',
        state: 'expired',
        data: {},
        retrycount: 0,
        retrylimit: 3,
        createdon: '2026-05-17T00:00:00Z',
      },
      'drop_relation' as any,
    );
    expect(expired.status).toBe('failed');
  });

  it('defaults retry_count to 0 and max_retries to 3 when missing', () => {
    const out = mapJobToPublic(
      {
        id: 'd1',
        state: 'created',
        data: {},
        createdon: '2026-05-17T00:00:00Z',
      },
      'create_collection' as any,
    );
    expect(out.retry_count).toBe(0);
    expect(out.max_retries).toBe(3);
  });
});

describe('S5-04 ddl-queue: QUEUE_NAMES', () => {
  it('has every DDL type the routes layer issues', () => {
    expect(QUEUE_NAMES.create_collection).toBe('ddl.create_collection');
    expect(QUEUE_NAMES.drop_collection).toBe('ddl.drop_collection');
    expect(QUEUE_NAMES.add_field).toBe('ddl.add_field');
    expect(QUEUE_NAMES.remove_field).toBe('ddl.remove_field');
    expect(QUEUE_NAMES.create_relation).toBe('ddl.create_relation');
    expect(QUEUE_NAMES.drop_relation).toBe('ddl.drop_relation');
  });

  it('all names share the ddl. prefix for grep-ability + pg-boss observability', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(name.startsWith('ddl.')).toBe(true);
    }
  });
});
