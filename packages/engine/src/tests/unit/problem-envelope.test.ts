/**
 * H-13 — unified error envelope. Exercises the real onError + normalizer against
 * an in-process Hono app (Hono's app.request test client), so it's deterministic
 * and needs no live engine. Proves every non-2xx is RFC 9457 problem+json.
 */

import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import {
  problem,
  problemNormalizer,
  problemOnError,
  PROBLEM_CONTENT_TYPE,
} from '../../lib/problem.js';

function makeApp(): Hono {
  const app = new Hono();
  app.onError(problemOnError);
  app.use('/api/*', problemNormalizer());

  app.get('/api/ok', (c) => c.json({ ok: true }));
  app.get('/api/legacy-403', (c) => c.json({ error: 'nope, denied' }, 403));
  app.get('/api/legacy-404', (c) => c.json({ error: 'missing' }, 404));
  app.get('/api/plain-500', (c) => c.text('kaboom', 500));
  app.get('/api/throw-problem', () => {
    throw problem('tenant.membership_required', 403, 'You are not a member of this tenant.');
  });
  app.get('/api/throw-generic', () => {
    throw new Error('internal secret detail that must not leak');
  });
  app.get('/api/zod', (c) =>
    c.json({ success: false, error: { issues: [{ path: ['name'], message: 'Required' }] } }, 400),
  );
  return app;
}

const app = makeApp();
const call = (path: string) => app.request(`http://local${path}`);

function isEnvelope(body: Record<string, unknown>, status: number): void {
  expect(typeof body.type).toBe('string');
  expect(typeof body.title).toBe('string');
  expect(body.status).toBe(status);
  expect(typeof body.code).toBe('string');
  expect(typeof body.traceId).toBe('string');
}

describe('H-13 error envelope', () => {
  it('2xx responses are left untouched', async () => {
    const res = await call('/api/ok');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).not.toContain('problem+json');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('legacy c.json({error}, 403) is rewrapped into problem+json (code=forbidden)', async () => {
    const res = await call('/api/legacy-403');
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 403);
    expect(body.code).toBe('forbidden');
    expect(body.detail).toBe('nope, denied');
    expect(body.instance).toBe('/api/legacy-403');
  });

  it('legacy 404 is rewrapped (code=not_found)', async () => {
    const res = await call('/api/legacy-404');
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 404);
    expect(body.code).toBe('not_found');
  });

  it('a plain non-JSON 500 body is still rewrapped', async () => {
    const res = await call('/api/plain-500');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 500);
    expect(body.code).toBe('internal_error');
  });

  it('thrown problem() carries the rich, stable code', async () => {
    const res = await call('/api/throw-problem');
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 403);
    expect(body.code).toBe('tenant.membership_required');
    expect(body.detail).toBe('You are not a member of this tenant.');
  });

  it('an unhandled throw becomes a generic 500 and never leaks the message', async () => {
    const res = await call('/api/throw-generic');
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 500);
    expect(body.code).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('secret detail');
  });

  it('a zValidator-style body maps to validation_failed + surfaces the issues', async () => {
    const res = await call('/api/zod');
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 400);
    expect(body.code).toBe('validation_failed');
    expect(Array.isArray(body.errors)).toBe(true);
  });
});
