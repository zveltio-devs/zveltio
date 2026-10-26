/**
 * Every configuration mutation needs the session's step-up window (ADR 0006,
 * middleware/config-step-up.ts); a person's own writes never do.
 *
 * Probe: a god signed in with a password and a passkey but no step-up yet, a god
 * with no factor at all, and an API key. A data write and a profile edit from the
 * same window-less session must pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { passkeyRelyingParty } from '../../lib/auth.js';
import { isConfigMutation } from '../../middleware/config-step-up.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { newSoftPasskey, passkeyStepUp, registerSoftPasskey } from '../../testing/step-up.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLL = `hcfgstep_${Date.now()}`;

d('configuration mutations need the step-up window', () => {
  let app: Awaited<ReturnType<typeof getTestApp>>['app'];
  let db: Database;
  let cookie = '';
  const req = (path: string, init?: RequestInit) => app.request(path, init);
  const send = (method: string, path: string, body?: unknown, c = cookie) =>
    req(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: c },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    cookie = await createGodSession(app, db, { factor: false });
  });

  afterAll(async () => {
    await dropTestCollection(db, COLL);
  });

  it('a god with no factor is sent to enroll one, and still writes data', async () => {
    const res = await send('POST', '/api/permissions/cache/invalidate', {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('step_up_enrollment_required');
    expect((await send('POST', `/api/data/${COLL}`, { title: 'a' })).status).toBe(201);
  });

  it('a passkey without a step-up is refused configuration until it steps up', async () => {
    const { origin } = passkeyRelyingParty();
    const pk = await newSoftPasskey();
    expect(
      (await registerSoftPasskey(req, cookie, pk, origin, { password: 'HarnessGod123!' })).status,
    ).toBe(200);

    for (const [method, path, body] of [
      ['POST', '/api/permissions/cache/invalidate', {}],
      ['PUT', '/api/settings/site_name', { value: 'x' }],
      ['POST', '/api/collections', { name: `${COLL}_x`, fields: [] }],
      ['DELETE', '/api/users/nobody', undefined],
    ] as const) {
      const res = await send(method, path, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: 'step_up_required',
        errors: { action: 'config' },
      });
    }

    // A person's own writes are not configuration.
    expect((await send('POST', `/api/data/${COLL}`, { title: 'b' })).status).toBe(201);
    expect((await send('PATCH', '/api/me', { name: 'Still Me' })).status).toBe(200);
    expect((await send('PUT', '/api/erd/layout', { positions: {} })).status).toBe(200);

    await passkeyStepUp(req, cookie, pk, 'config', origin);
    expect((await send('POST', '/api/permissions/cache/invalidate', {})).status).toBe(200);
  });

  it('the god recovery door is not configuration', () => {
    expect(isConfigMutation('POST', '/api/permissions/bootstrap')).toBe(false);
    expect(isConfigMutation('POST', '/api/rpc/my_fn')).toBe(false);
    expect(isConfigMutation('POST', '/api/rpc')).toBe(true);
    expect(isConfigMutation('DELETE', '/api/rpc/abc')).toBe(true);
    expect(isConfigMutation('GET', '/api/collections')).toBe(false);
    expect(isConfigMutation('POST', '/api/collectionsx')).toBe(false);
  });
});
