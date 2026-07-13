/**
 * problem.ts — remaining catalogued STATUS_TITLES / DEFAULT_CODES entries.
 */

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { problemNormalizer, PROBLEM_CONTENT_TYPE } from '../../lib/problem.js';

function appWithStatus(status: number): Hono {
  const app = new Hono();
  app.use('/api/*', problemNormalizer());
  app.get(
    '/api/x',
    () =>
      new Response(JSON.stringify({ error: 'detail' }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  return app;
}

describe('problem envelope — remaining catalog statuses', () => {
  it.each([
    [413, 'payload_too_large', 'Payload Too Large'],
    [415, 'unsupported_media_type', 'Unsupported Media Type'],
    [429, 'rate_limited', 'Too Many Requests'],
    [502, 'bad_gateway', 'Bad Gateway'],
    [504, 'gateway_timeout', 'Gateway Timeout'],
  ] as const)('normalizes %i with code=%s title=%s', async (status, code, title) => {
    const res = await appWithStatus(status).request('http://local/api/x');
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe(code);
    expect(body.title).toBe(title);
    expect(body.detail).toBe('detail');
  });
});
