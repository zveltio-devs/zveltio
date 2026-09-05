/**
 * Demoting a god has to drop BOTH cached facts about their role.
 *
 * `god:<id>` answers "is this user god" and `urole:<id>` answers "what is this
 * user's role". `invalidateGodCache` deleted only the first, so the second kept
 * saying `god` for the rest of its 300 s TTL. Measured against a live Valkey,
 * demoting a god in the database and then invalidating:
 *
 *   cached           → god:=set     urole:=["god"]
 *   after invalidate → god:=absent  urole:=["god"]
 *   resolveUserRole  → god
 *
 * That is not a stale display. `routes/rpc.ts` passes `resolveUserRole` straight
 * into `userHasRole`, which returns true unconditionally for `'god'` — so the
 * demoted holder kept a full RPC bypass. The only caller of this function is the
 * recovery-token flow, whose entire premise is that the previous holder has lost
 * control of the instance.
 *
 * Skipped when VALKEY_URL is unset; the defect only exists where a shared cache
 * does, because the in-process copies were always cleared.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import Redis from 'ioredis';
import { initCache } from '../../lib/runtime/index.js';
import { invalidateGodCache } from '../../lib/tenancy/index.js';

const VALKEY_URL = process.env.VALKEY_URL;

describe.skipIf(!VALKEY_URL)('invalidateGodCache (live Valkey)', () => {
  const probe = new Redis(VALKEY_URL ?? '', { maxRetriesPerRequest: 1, lazyConnect: true });
  afterAll(() => {
    probe.disconnect();
  });

  it('drops the role key as well as the god flag', async () => {
    await initCache();
    const id = `god-cache-probe-${crypto.randomUUID()}`;

    // The values are never read back — only whether the keys survive — so they
    // do not need the HMAC the real writers apply.
    await probe.set(`god:${id}`, '1:deadbeef');
    await probe.set(`urole:${id}`, '["god"]:deadbeef');
    expect(await probe.get(`god:${id}`)).not.toBeNull();
    expect(await probe.get(`urole:${id}`)).not.toBeNull();

    await invalidateGodCache(id);

    expect(await probe.get(`god:${id}`)).toBeNull();
    // The one that used to be left behind.
    expect(await probe.get(`urole:${id}`)).toBeNull();
  });
});
