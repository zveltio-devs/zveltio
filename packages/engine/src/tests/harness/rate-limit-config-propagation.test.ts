/**
 * Every rate-limit tier can be tuned, reset, and a change reaches every
 * instance at once.
 *
 * Only six tiers had a row in `zv_rate_limit_configs`, and PATCH updates rows:
 * `files`, `ext`, `form`, `share`, `scim`, `edge-public` and
 * `recovery-bootstrap` answered 404, and reset restored a hardcoded list of the
 * six. A change also reached only the instance that made it; the others kept
 * the cached limit for up to a minute.
 *
 * The cross-instance case plays both replicas in one process, like
 * `casbin-cross-instance-policy.test.ts`: the real PATCH runs here (instance A)
 * with the bus publish captured, the cache is put back to what a replica that
 * never heard of it would hold (instance B), and the captured message is
 * delivered through `dispatchToWs` as the Valkey / pg_notify subscriber does.
 *
 * NODE_ENV is flipped off `test`, where the limiter bypasses itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import {
  dispatchToWs,
  RATE_LIMIT_CONFIG_CHANGED_EVENT,
  realtimeBus,
  type RealtimeBusMessage,
} from '../../lib/runtime/index.js';
import {
  clearLocalRateLimitCache,
  rateLimitDefaults,
  rateLimitTiers,
} from '../../middleware/rate-limit.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('rate-limit config: every tier tunable, changes reach every instance', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  const savedEnv = process.env.NODE_ENV;
  const savedProxy = process.env.TRUSTED_PROXY;
  const bus = realtimeBus();
  const origPublish = bus.publish;
  /** Each captured message, with the `files` row as another connection saw it then. */
  const sent: Array<{ msg: Omit<RealtimeBusMessage, 'originId'>; committedMax: number }> = [];
  let ipSeq = 0;
  const nextIp = () => `203.0.113.${++ipSeq}`;

  const filesRow = async () =>
    (
      await sql<{ max_requests: number; window_ms: number }>`
        SELECT max_requests, window_ms FROM zv_rate_limit_configs
         WHERE key_prefix = 'files'`.execute(db)
    ).rows[0];

  /** Statuses of `n` anonymous /files requests from one fresh address. */
  async function files(n: number): Promise<number[]> {
    const ip = nextIp();
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await app.request('/files/media/nothing.png', {
        headers: { 'x-forwarded-for': ip },
      });
      out.push(res.status);
    }
    return out;
  }

  function admin(path: string, method: string, body?: unknown) {
    return app.request(`/api/admin/rate-limits${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: god, 'x-forwarded-for': nextIp() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const filesMessages = () =>
    sent.filter(
      (s) =>
        s.msg.event === RATE_LIMIT_CONFIG_CHANGED_EVENT &&
        (s.msg.data as { keyPrefix?: string } | undefined)?.keyPrefix === 'files',
    );

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    bus.publish = async (payload) => {
      // `db` is the pool: it sees only what has committed.
      sent.push({ msg: payload, committedMax: (await filesRow())?.max_requests ?? -1 });
    };
    process.env.NODE_ENV = 'development';
    process.env.TRUSTED_PROXY = 'true';
  });

  afterAll(async () => {
    bus.publish = origPublish;
    process.env.NODE_ENV = savedEnv;
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
    await admin('/reset', 'POST');
  });

  it('seeds a row for every tier a limiter was built for', async () => {
    const rows = await sql<{ key_prefix: string }>`
      SELECT key_prefix FROM zv_rate_limit_configs`.execute(db);
    const have = new Set(rows.rows.map((r) => r.key_prefix));
    for (const tier of ['files', 'ext', 'form', 'share', 'scim']) {
      expect(rateLimitTiers()).toContain(tier);
    }
    expect(rateLimitTiers().filter((t) => !have.has(t))).toEqual([]);
  });

  it('PATCH files applies to the limiter, and reset restores the compiled default', async () => {
    const res = await admin('/files', 'PATCH', { max_requests: 2 });
    expect(res.status).toBe(200);
    const seen = await files(3);
    expect(seen.slice(0, 2)).not.toContain(429);
    expect(seen[2]).toBe(429);

    expect((await admin('/reset', 'POST')).status).toBe(200);
    const compiled = rateLimitDefaults().find((r) => r.key_prefix === 'files');
    expect(compiled).toEqual({ key_prefix: 'files', window_ms: 60_000, max_requests: 1200 });
    expect(await filesRow()).toEqual({ max_requests: 1200, window_ms: 60_000 });
    expect(await files(3)).not.toContain(429);
  });

  it('a change reaches the other instance through the bus, after it commits', async () => {
    sent.length = 0;
    // Instance A: the admin PATCH.
    expect((await admin('/files', 'PATCH', { max_requests: 2 })).status).toBe(200);
    // The publish is an after-commit job; let it run.
    for (let i = 0; i < 50 && filesMessages().length === 0; i++) await Bun.sleep(10);
    const published = filesMessages();
    expect(published).toHaveLength(1);
    // Published after the commit: a receiver re-reading at once gets the new row.
    expect(published[0]!.committedMax).toBe(2);

    // Instance B cached 1200 before A's write and never heard of it.
    await sql`UPDATE zv_rate_limit_configs SET max_requests = 1200
               WHERE key_prefix = 'files'`.execute(db);
    clearLocalRateLimitCache('files');
    expect(await files(1)).not.toContain(429);
    await sql`UPDATE zv_rate_limit_configs SET max_requests = 2
               WHERE key_prefix = 'files'`.execute(db);
    expect(await files(3)).not.toContain(429);

    for (const { msg } of published) await dispatchToWs({ ...msg, originId: 'replica-a' });
    const after = await files(3);
    expect(after[2]).toBe(429);
  });
});
