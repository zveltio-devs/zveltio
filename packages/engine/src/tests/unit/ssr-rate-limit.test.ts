import { afterAll, beforeAll, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { ssrRateLimit } from '../../middleware/rate-limit.js';

/**
 * The public client's render path calls `ssrRateLimit` with a no-op `next`
 * (index.ts catch-all): under the limit it answers nothing, over it the 429.
 */
let savedEnv: string | undefined;
let savedProxy: string | undefined;
beforeAll(() => {
  savedEnv = process.env.NODE_ENV;
  savedProxy = process.env.TRUSTED_PROXY;
  process.env.NODE_ENV = 'development'; // the limiter bypasses itself under 'test'
  process.env.TRUSTED_PROXY = 'true';
  _setCacheForTests(null);
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv;
  if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
  else process.env.TRUSTED_PROXY = savedProxy;
});

it('a visitor past the ssr tier gets 429 instead of a render', async () => {
  const app = new Hono();
  let renders = 0;
  app.get('/*', async (c) => {
    const limited = await ssrRateLimit(c, async () => {});
    if (limited) return limited;
    renders++;
    return c.text('page');
  });
  const ip = `198.51.100.${Math.floor(Math.random() * 200)}`;
  const statuses: number[] = [];
  for (let i = 0; i < 301; i++) {
    statuses.push((await app.request('/p', { headers: { 'x-real-ip': ip } })).status);
  }
  expect(renders).toBe(300);
  expect(statuses.at(-1)).toBe(429);
});
