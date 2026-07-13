/**
 * problem.ts — problemNormalizer swallows clone().text() failures.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { problemNormalizer, PROBLEM_CONTENT_TYPE } from '../../lib/problem.js';

describe('problemNormalizer — clone text failure', () => {
  it('rewraps a 4xx even when reading the response body throws', async () => {
    const app = new Hono();
    app.use('/api/*', problemNormalizer());
    app.get('/api/unreadable', (c) => c.json({ error: 'legacy' }, 403));

    const textSpy = spyOn(Response.prototype, 'text').mockImplementation(async function (
      this: Response,
    ) {
      const url = this.url ?? '';
      if (url.includes('/api/unreadable')) throw new Error('stream corrupted');
      return '';
    });

    try {
      const res = await app.request('http://local/api/unreadable');
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
      const body = (await res.json()) as { code: string; detail?: string };
      expect(body.code).toBe('forbidden');
      expect(body.detail).toBe('');
    } finally {
      textSpy.mockRestore();
    }
  });
});
