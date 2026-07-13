/**
 * problem.ts — STATUS_TITLES / DEFAULT_CODES for catalogued HTTP statuses.
 */

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { problemNormalizer, PROBLEM_CONTENT_TYPE } from '../../lib/problem.js';

function appWithStatus(status: number, body: Record<string, string>): Hono {
  const app = new Hono();
  app.use('/api/*', problemNormalizer());
  app.get(
    '/api/x',
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  return app;
}

describe('problem envelope — catalog status codes', () => {
  it.each([
    [405, 'method_not_allowed', 'Method Not Allowed'],
    [410, 'gone', 'Gone'],
    [501, 'not_implemented', 'Not Implemented'],
    [503, 'unavailable', 'Service Unavailable'],
  ] as const)('normalizes %i with code=%s title=%s', async (status, code, title) => {
    const res = await appWithStatus(status, { error: 'detail here' }).request('http://local/api/x');
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe(code);
    expect(body.title).toBe(title);
    expect(body.detail).toBe('detail here');
  });
});
