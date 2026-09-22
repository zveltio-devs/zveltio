import { describe, expect, it } from 'vitest';

/**
 * The control for the rest of this lane.
 *
 * Every other file here passes because a session cookie rides along on each
 * request. If the engine were answering admin routes to anyone, those files
 * would pass just as green and prove nothing — so this one asserts the door is
 * shut, using the same `fetch` with an empty `cookie` header (the jar installed
 * in `tests/integration/setup.ts` only fills one in when the caller sent none).
 */
const BASE = process.env.STUDIO_IT_BASE_URL ?? 'http://127.0.0.1:3399';

describe('the session is what carries this lane', () => {
  it('refuses /api/collections without a cookie', async () => {
    const res = await fetch(`${BASE}/api/collections`, { headers: { cookie: '' } });
    expect(res.status, 'an admin route answered an anonymous caller').toBe(401);
  });

  it('answers the same route with one', async () => {
    const res = await fetch(`${BASE}/api/collections`);
    expect(res.status).toBe(200);
  });
});
