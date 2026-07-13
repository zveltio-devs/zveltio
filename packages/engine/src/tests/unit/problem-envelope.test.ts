/**
 * H-13 — unified error envelope. Exercises the real onError + normalizer against
 * an in-process Hono app (Hono's app.request test client), so it's deterministic
 * and needs no live engine. Proves every non-2xx is RFC 9457 problem+json.
 */

import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import {
  problem,
  problemNormalizer,
  problemNotFound,
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
  app.notFound(problemNotFound);
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

  it('legacy bodies with a detail field are normalized', async () => {
    const app = new Hono();
    app.use('/api/*', problemNormalizer());
    app.get('/api/legacy-detail', (c) => c.json({ detail: 'field X is invalid' }, 409));
    const res = await app.request('http://local/api/legacy-detail');
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 409);
    expect(body.detail).toBe('field X is invalid');
  });

  it('legacy bodies with an explicit code are preserved', async () => {
    const app = new Hono();
    app.use('/api/*', problemNormalizer());
    app.get('/api/legacy-code', (c) => c.json({ error: 'nope', code: 'custom_legacy' }, 403));
    const res = await app.request('http://local/api/legacy-code');
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 403);
    expect(body.code).toBe('custom_legacy');
  });

  it('malformed JSON bodies fall back to the raw text snippet', async () => {
    const app = new Hono();
    app.use('/api/*', problemNormalizer());
    app.get('/api/bad-json', (c) => c.body('{ not json', 400));
    const res = await app.request('http://local/api/bad-json');
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 400);
    expect(body.detail).toBe('{ not json');
  });

  it('legacy bodies with a message field are normalized', async () => {
    const app = new Hono();
    app.use('/api/*', problemNormalizer());
    app.get('/api/legacy-msg', (c) => c.json({ message: 'bad input' }, 422));
    const res = await app.request('http://local/api/legacy-msg');
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 422);
    expect(body.detail).toBe('bad input');
    expect(body.code).toBe('validation_failed');
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

  it('app.notFound(problemNotFound) returns a problem+json 404 envelope', async () => {
    const res = await call('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 404);
    expect(body.code).toBe('not_found');
    expect(body.detail).toBe('No route for GET /api/does-not-exist.');
    expect(body.instance).toBe('/api/does-not-exist');
  });

  it('problemNotFound extracts traceId from traceparent when invoked directly', async () => {
    const trace = '00-abcdef0123456789abcdef0123456789-0123456789abcdef-01';
    const c = {
      req: {
        method: 'PATCH',
        path: '/api/missing',
        header: (name: string) => (name === 'traceparent' ? trace : undefined),
      },
      res: { headers: { get: () => null } },
    } as unknown as Context;

    const res = problemNotFound(c);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.traceId).toBe('abcdef0123456789abcdef0123456789');
    expect(body.detail).toBe('No route for PATCH /api/missing.');
  });

  it('problemOnError maps HTTPException to problem+json with default code', async () => {
    const app = new Hono();
    app.onError(problemOnError);
    app.get('/teapot', () => {
      throw new HTTPException(418, { message: 'short and stout' });
    });
    const res = await app.request('http://local/teapot');
    expect(res.status).toBe(418);
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 418);
    expect(body.detail).toBe('short and stout');
    expect(typeof body.code).toBe('string');
  });

  it('problemOnError extracts traceId from response traceparent when request header is absent', async () => {
    const trace = '00-fedcba9876543210fedcba9876543210-0123456789abcdef-01';
    const app = new Hono();
    app.onError(problemOnError);
    app.get('/api/trace-res', (c) => {
      c.res.headers.set('traceparent', trace);
      throw problem('demo.trace', 400, 'trace from response headers');
    });
    const res = await app.request('http://local/api/trace-res');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.traceId).toBe('fedcba9876543210fedcba9876543210');
  });

  it('thrown problem() surfaces structured errors on the envelope', async () => {
    const app = new Hono();
    app.onError(problemOnError);
    app.get('/api/field-errors', () => {
      throw problem('validation.field_errors', 422, 'Fix the fields', {
        name: ['Required'],
      });
    });
    const res = await app.request('http://local/api/field-errors');
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 422);
    expect(body.code).toBe('validation.field_errors');
    expect(body.errors).toEqual({ name: ['Required'] });
  });

  it('normalizes uncommon 5xx statuses with generic server-error codes', async () => {
    const app = new Hono();
    app.use('/api/*', problemNormalizer());
    app.get(
      '/api/unusual',
      () =>
        new Response(JSON.stringify({ error: 'upstream died' }), {
          status: 599,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const res = await app.request('http://local/api/unusual');
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 599);
    expect(body.code).toBe('internal_error');
    expect(body.title).toBe('Server Error');
    expect(body.detail).toBe('upstream died');
  });

  it('normalizes uncommon 4xx statuses with request-error codes', async () => {
    const app = new Hono();
    app.use('/api/*', problemNormalizer());
    app.get(
      '/api/client-weird',
      () =>
        new Response(JSON.stringify({ error: 'nope' }), {
          status: 499,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const res = await app.request('http://local/api/client-weird');
    const body = (await res.json()) as Record<string, unknown>;
    isEnvelope(body, 499);
    expect(body.code).toBe('request_error');
    expect(body.title).toBe('Request Error');
  });

  it('problemNormalizer leaves responses that are already problem+json untouched', async () => {
    const app = new Hono();
    app.use('/api/*', problemNormalizer());
    app.get('/api/problem', (c) =>
      c.json(
        {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          code: 'custom_code',
          traceId: 'trace-1',
        },
        403,
        { 'content-type': PROBLEM_CONTENT_TYPE },
      ),
    );
    const res = await app.request('http://local/api/problem');
    expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('custom_code');
  });
});
