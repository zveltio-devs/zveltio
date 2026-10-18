/**
 * Extension job queues against a stand-in pg-boss whose `createQueue` the test
 * holds open: an unload while the queue is being created adds no worker, an
 * enqueue waits for its queue, and a failed creation fails the enqueue.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { _setBossForTests } from '../../lib/data/index.js';
import {
  type CompiledJob,
  enqueueJob,
  jobQueueName,
  registerJobs,
  unregisterJobs,
} from '../../lib/extensions/jobs.js';
import type { GatePrincipal } from '../../middleware/extension-auth-gate.js';

function standIn() {
  let open!: () => void;
  let fail!: (err: Error) => void;
  const created = new Promise<void>((res, rej) => {
    open = res;
    fail = rej;
  });
  const calls = { work: [] as string[], offWork: [] as string[], send: [] as string[] };
  const boss = {
    createQueue: () => created,
    work: async (q: string) => {
      calls.work.push(q);
      return 'w';
    },
    offWork: async (q: string) => {
      calls.offWork.push(q);
    },
    send: async (q: string) => {
      calls.send.push(q);
      return 'job-id';
    },
  };
  return { boss, calls, open, fail };
}

const job: CompiledJob = {
  name: 'go',
  input: z.object({}),
  reads: new Set(),
  writes: new Set(),
  retry: { limit: 0, backoff: false },
  run: async () => {},
};
const principal = {
  user: { id: 'u1', name: 'u', role: 'member' },
  authType: 'session',
  trx: { isTransaction: false },
  tenantId: '00000000-0000-0000-0000-000000000001',
} as unknown as GatePrincipal;
const action = { name: 'a', enqueues: new Set(['go']) };
const tick = () => new Promise((r) => setTimeout(r, 0));

let previous: unknown;
afterEach(async () => {
  for (const ext of ['jq-unload', 'jq-wait', 'jq-fail']) await unregisterJobs(ext);
  _setBossForTests(previous);
});

describe('extension job queues', () => {
  it('adds no worker for an extension unloaded while its queue was created', async () => {
    const s = standIn();
    previous = _setBossForTests(s.boss);
    registerJobs('jq-unload', new Map([['go', job]]), ['data:system']);
    const unloaded = unregisterJobs('jq-unload');
    s.open();
    await unloaded;
    await tick();
    expect(s.calls.work).toEqual([]);
  });

  it('holds an enqueue until its queue exists', async () => {
    const s = standIn();
    previous = _setBossForTests(s.boss);
    registerJobs('jq-wait', new Map([['go', job]]), ['data:system']);
    const queued = enqueueJob('jq-wait', principal, action, 'go', {});
    await tick();
    expect(s.calls.send).toEqual([]);
    s.open();
    expect(await queued).toBe('job-id');
    expect(s.calls.send).toEqual([jobQueueName('jq-wait', 'go')]);
    expect(s.calls.work).toEqual([jobQueueName('jq-wait', 'go')]);
  });

  it('fails an enqueue whose queue could not be created', async () => {
    const s = standIn();
    previous = _setBossForTests(s.boss);
    registerJobs('jq-fail', new Map([['go', job]]), ['data:system']);
    const queued = enqueueJob('jq-fail', principal, action, 'go', {});
    s.fail(new Error('permission denied for schema pgboss'));
    await expect(queued).rejects.toThrow('permission denied for schema pgboss');
    expect(s.calls.send).toEqual([]);
  });
});
