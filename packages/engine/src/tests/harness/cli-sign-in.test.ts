/**
 * The CLI's browser confirmation (lib/cli-sign-in.ts, ADR 0011 amendment 1),
 * driven through the app: the CLI side with no cookie, the Console side as a
 * god with a soft passkey stepping up for `cli.approve:<code>`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { createSteppedUpGod, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

type God = Awaited<ReturnType<typeof createSteppedUpGod>>;
let app: Hono;
let db: Database;
let god: God;
let other: God;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function start(body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request('/api/auth/cli/start', json(body, headers));
  expect(res.status).toBe(200);
  return (await res.json()) as { device_code: string; user_code: string };
}
const poll = async (device_code: string) => {
  const res = await app.request('/api/auth/cli/poll', json({ device_code }));
  return { status: res.status, body: (await res.json()) as { status: string; token?: string } };
};
const approve = async (as: God, code: string) =>
  app.request(
    '/api/auth/cli/approve',
    json({ code }, { cookie: as.cookie, ...(await as.stepUp(`cli.approve:${code}`)) }),
  );

d('CLI confirmation through the browser', () => {
  let bearer = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    // One god per instance: the later one stays god, the earlier is demoted to a
    // member who keeps the passkey, which is what approving as "another account" needs.
    other = await createSteppedUpGod(app, db);
    god = await createSteppedUpGod(app, db);
  });
  afterAll(async () => {
    await _settleAuditWrites();
  });

  it('signs the CLI in as the user who approves, once', async () => {
    const { device_code, user_code } = await start({ kind: 'login' });
    expect(user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect((await poll(device_code)).body.status).toBe('pending');

    // The Console shows the request before anything is approved.
    const shown = await app.request(`/api/auth/cli/request?code=${user_code}`, {
      headers: { cookie: god.cookie },
    });
    expect(((await shown.json()) as { kind: string }).kind).toBe('login');

    // A session without a step-up does not approve.
    const bare = await app.request(
      '/api/auth/cli/approve',
      json({ code: user_code }, { cookie: god.cookie }),
    );
    expect(bare.status).toBe(403);

    expect((await approve(god, user_code)).status).toBe(200);
    const done = await poll(device_code);
    expect(done.body.status).toBe('approved');
    bearer = done.body.token!;

    const me = await app.request('/api/auth/get-session', {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    const meBody = (await me.json()) as { user?: { id: string } };
    const godMe = (await (
      await app.request('/api/auth/get-session', { headers: { cookie: god.cookie } })
    ).json()) as { user: { id: string } };
    expect(meBody.user?.id).toBe(godMe.user.id);

    // The result is handed out once, and the code is spent.
    expect((await poll(device_code)).status).toBe(410);
    expect((await approve(god, user_code)).status).toBe(410);
  });

  it("steps up the CLI's own session for one action, approved only by its user", async () => {
    expect(bearer).not.toBe('');
    const action = 'extension.install:no-such-ext-cli';
    const auth = { Authorization: `Bearer ${bearer}` };
    // The route asks for a step-up first, and answers 404 once it has one.
    const install = (headers: Record<string, string>) =>
      app.request('/api/marketplace/no-such-ext-cli/install', { method: 'POST', headers });
    expect((await install(auth)).status).toBe(403);

    const { device_code, user_code } = await start({ kind: 'step-up', action }, auth);
    // Another account cannot approve, and trying does not cancel it.
    expect((await approve(other, user_code)).status).toBe(403);
    expect((await poll(device_code)).body.status).toBe('pending');

    expect((await approve(god, user_code)).status).toBe(200);
    const token = (await poll(device_code)).body.token!;
    const res = await install({ ...auth, 'X-Zveltio-Step-Up': token });
    expect(res.status).toBe(404); // past the gate and the step-up: no such extension
    // One use.
    expect((await install({ ...auth, 'X-Zveltio-Step-Up': token })).status).toBe(403);
  });

  it('a step-up request needs the CLI session, and a denied request ends', async () => {
    const anon = await app.request(
      '/api/auth/cli/start',
      json({ kind: 'step-up', action: 'extension.install:x' }),
    );
    expect(anon.status).toBe(401);

    const { device_code, user_code } = await start({ kind: 'login' });
    const deny = await app.request(
      '/api/auth/cli/deny',
      json({ code: user_code }, { cookie: god.cookie }),
    );
    expect(((await deny.json()) as { denied: boolean }).denied).toBe(true);
    expect((await poll(device_code)).status).toBe(410);
  });

  it('a poll racing the approval waits for its result, never reports it expired', async () => {
    // Approve takes the request, mints the session, then stores the result: a
    // poll in between found neither and told the CLI the request was gone.
    for (let round = 0; round < 3; round++) {
      const { device_code, user_code } = await start({ kind: 'login' });
      const headers = { cookie: god.cookie, ...(await god.stepUp(`cli.approve:${user_code}`)) };
      // The CLI polls until it gets an answer; here, back to back.
      const answer = (async () => {
        for (;;) {
          const p = await poll(device_code);
          if (p.body.status !== 'pending') return p.status;
        }
      })();
      const res = await app.request('/api/auth/cli/approve', json({ code: user_code }, headers));
      expect(res.status).toBe(200);
      expect(await answer).toBe(200);
    }
  });

  it('the CLI polling at its interval leaves the auth limit to the person approving', async () => {
    // The limit is off under NODE_ENV=test; this test needs it on.
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const { device_code, user_code } = await start({ kind: 'login' });
      // One minute of polls at the advertised three-second interval, from the
      // same address as the browser (the person's own machine).
      for (let i = 0; i < 20; i++) await poll(device_code);
      const shown = await app.request(`/api/auth/cli/request?code=${user_code}`, {
        headers: { cookie: god.cookie },
      });
      expect(shown.status).toBe(200);
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});
