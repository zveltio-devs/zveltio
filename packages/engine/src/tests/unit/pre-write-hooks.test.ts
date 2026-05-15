import { describe, it, expect, beforeEach } from 'bun:test';
import { engineEvents, AbortHookError } from '../../lib/event-bus.js';

beforeEach(() => {
  engineEvents.clearPreHooks();
});

describe('engineEvents.runBefore — beforeInsert', () => {
  it('returns the seed payload unchanged when no handlers are registered', async () => {
    const result = await engineEvents.runBefore('record.beforeInsert', {
      collection: 'contacts',
      data: { email: 'A@example.com' },
      userId: 'u1',
    });
    expect(result.data).toEqual({ email: 'A@example.com' });
    expect(result.collection).toBe('contacts');
    expect(result.userId).toBe('u1');
    expect(typeof result.abort).toBe('function');
    expect(typeof result.mutate).toBe('function');
  });

  it('applies mutate(...) — data is merged for the data layer', async () => {
    engineEvents.onBefore('record.beforeInsert', (p) => {
      p.mutate({ email: (p.data.email as string).toLowerCase(), source: 'api' });
    });
    const result = await engineEvents.runBefore('record.beforeInsert', {
      collection: 'contacts',
      data: { email: 'A@example.com' },
      userId: 'u1',
    });
    expect(result.data).toEqual({ email: 'a@example.com', source: 'api' });
  });

  it('runs handlers sequentially and stacks mutations', async () => {
    engineEvents.onBefore('record.beforeInsert', (p) => {
      p.mutate({ a: 1 });
    });
    engineEvents.onBefore('record.beforeInsert', (p) => {
      // Second handler sees the first handler's patch
      expect(p.data.a).toBe(1);
      p.mutate({ b: 2 });
    });
    const result = await engineEvents.runBefore('record.beforeInsert', {
      collection: 'x',
      data: {},
      userId: 'u',
    });
    expect(result.data).toEqual({ a: 1, b: 2 });
  });

  it('abort() throws AbortHookError with the reason', async () => {
    engineEvents.onBefore('record.beforeInsert', (p) => {
      p.abort('quota exceeded');
    });
    await expect(
      engineEvents.runBefore('record.beforeInsert', {
        collection: 'x',
        data: { foo: 'bar' },
        userId: 'u',
      }),
    ).rejects.toBeInstanceOf(AbortHookError);

    try {
      await engineEvents.runBefore('record.beforeInsert', {
        collection: 'x',
        data: {},
        userId: 'u',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AbortHookError);
      expect((err as AbortHookError).reason).toBe('quota exceeded');
    }
  });

  it('short-circuits — handlers after an abort do not run', async () => {
    let secondCalled = false;
    engineEvents.onBefore('record.beforeInsert', (p) => {
      p.abort('stop');
    });
    engineEvents.onBefore('record.beforeInsert', () => {
      secondCalled = true;
    });
    await expect(
      engineEvents.runBefore('record.beforeInsert', {
        collection: 'x',
        data: {},
        userId: 'u',
      }),
    ).rejects.toBeInstanceOf(AbortHookError);
    expect(secondCalled).toBe(false);
  });

  it('supports async handlers (awaits them)', async () => {
    engineEvents.onBefore('record.beforeInsert', async (p) => {
      await Bun.sleep(5);
      p.mutate({ geocoded: true });
    });
    const result = await engineEvents.runBefore('record.beforeInsert', {
      collection: 'x',
      data: { addr: '1 Main' },
      userId: 'u',
    });
    expect(result.data).toEqual({ addr: '1 Main', geocoded: true });
  });

  it('unsubscribe removes the handler', async () => {
    let called = false;
    const unsub = engineEvents.onBefore('record.beforeInsert', () => {
      called = true;
    });
    expect(engineEvents.preHookCount('record.beforeInsert')).toBe(1);
    unsub();
    expect(engineEvents.preHookCount('record.beforeInsert')).toBe(0);

    await engineEvents.runBefore('record.beforeInsert', {
      collection: 'x',
      data: {},
      userId: 'u',
    });
    expect(called).toBe(false);
  });
});

describe('engineEvents.runBefore — beforeUpdate', () => {
  it('exposes before + patch and mutate writes to patch', async () => {
    engineEvents.onBefore('record.beforeUpdate', (p) => {
      expect(p.before).toEqual({ name: 'Old' });
      p.mutate({ updated_at: 'now' });
    });
    const result = await engineEvents.runBefore('record.beforeUpdate', {
      collection: 'contacts',
      id: 'r1',
      before: { name: 'Old' },
      patch: { name: 'New' },
      userId: 'u',
    });
    expect(result.patch).toEqual({ name: 'New', updated_at: 'now' });
    expect(result.before).toEqual({ name: 'Old' }); // unchanged
  });
});

describe('engineEvents.runBefore — beforeDelete', () => {
  it('omits mutate and only exposes abort', async () => {
    let observed: any = null;
    engineEvents.onBefore('record.beforeDelete', (p) => {
      observed = p;
    });
    const result = await engineEvents.runBefore('record.beforeDelete', {
      collection: 'x',
      id: 'r1',
      record: { id: 'r1', name: 'Doomed' },
      userId: 'u',
    });
    expect(typeof observed.abort).toBe('function');
    expect((observed as any).mutate).toBeUndefined();
    expect(result.record).toEqual({ id: 'r1', name: 'Doomed' });
  });

  it('can abort with reason', async () => {
    engineEvents.onBefore('record.beforeDelete', (p) => {
      p.abort('foreign key would orphan');
    });
    await expect(
      engineEvents.runBefore('record.beforeDelete', {
        collection: 'x',
        id: 'r1',
        record: { id: 'r1' },
        userId: 'u',
      }),
    ).rejects.toThrow('foreign key would orphan');
  });
});

describe('AbortHookError', () => {
  it('captures the reason and is identifiable via instanceof', () => {
    const err = new AbortHookError('not allowed today');
    expect(err.reason).toBe('not allowed today');
    expect(err.name).toBe('AbortHookError');
    expect(err.message).toContain('not allowed today');
    expect(err instanceof AbortHookError).toBe(true);
  });
});

// Simulates the bulk-handler pattern: a loop over rows calls runBefore per row
// and converts AbortHookError into a per-row errors[] entry without exiting
// the loop. This is the contract data.ts bulk handlers rely on.
describe('bulk pattern — per-row hooks with abort collection', () => {
  it('aborts a single row mid-batch without affecting the rest', async () => {
    engineEvents.onBefore('record.beforeInsert', (p) => {
      if ((p.data as any).flag === 'reject') {
        p.abort('forbidden value');
      }
      p.mutate({ stamped: true });
    });

    const rows = [
      { id: 1, flag: 'ok' },
      { id: 2, flag: 'reject' },
      { id: 3, flag: 'ok' },
    ];

    const accepted: any[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      try {
        const hooked = await engineEvents.runBefore('record.beforeInsert', {
          collection: 'test',
          data: rows[i],
          userId: 'u',
        });
        accepted.push(hooked.data);
      } catch (err) {
        if (err instanceof AbortHookError) {
          errors.push({ index: i, error: err.reason });
          continue;
        }
        throw err;
      }
    }

    expect(accepted).toHaveLength(2);
    expect(accepted[0]).toMatchObject({ id: 1, stamped: true });
    expect(accepted[1]).toMatchObject({ id: 3, stamped: true });
    expect(errors).toEqual([{ index: 1, error: 'forbidden value' }]);
  });

  it('non-abort errors break the loop (whole-batch fail)', async () => {
    engineEvents.onBefore('record.beforeInsert', () => {
      throw new Error('database explosion');
    });

    await expect(
      engineEvents.runBefore('record.beforeInsert', {
        collection: 'x',
        data: {},
        userId: 'u',
      }),
    ).rejects.toThrow('database explosion');
  });
});
