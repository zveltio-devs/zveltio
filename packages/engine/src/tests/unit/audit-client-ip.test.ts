import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { clientIpForAudit, resolveClientIp } from '../../lib/security/index.js';
import { requestLogMiddleware } from '../../middleware/request-log.js';

/**
 * An audit row must not record an address the caller chose.
 *
 * `god-audit`, `request-log` and the recovery-token endpoint all used to read
 * `x-forwarded-for` / `x-real-ip` straight off the request, with no
 * `TRUSTED_PROXY` check and no validation — while the rate limiter, in the same
 * directory, refuses those same headers unless the flag says the edge strips
 * them. A forgeable forensic trail is worse than an absent one, because it
 * invites belief.
 */
describe('the address written to an audit trail', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.TRUSTED_PROXY;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = saved;
  });

  /** Reads the resolver through a real context, the way middleware does. */
  async function resolved(headers: Record<string, string>) {
    const app = new Hono();
    let seen: { audit: string | null; bucket: string } | undefined;
    app.get('/probe', (c) => {
      seen = { audit: clientIpForAudit(c), bucket: resolveClientIp(c) };
      return c.text('ok');
    });
    await app.request('/probe', { headers });
    return seen!;
  }

  it('ignores forged proxy headers when TRUSTED_PROXY is not set', async () => {
    delete process.env.TRUSTED_PROXY;
    expect((await resolved({ 'x-forwarded-for': '9.9.9.9' })).audit).toBeNull();
    expect((await resolved({ 'x-real-ip': '9.9.9.9' })).audit).toBeNull();
  });

  it('believes a well-formed header only behind TRUSTED_PROXY', async () => {
    process.env.TRUSTED_PROXY = 'true';
    expect((await resolved({ 'x-forwarded-for': '198.51.100.7' })).audit).toBe('198.51.100.7');
    expect((await resolved({ 'x-real-ip': '198.51.100.8' })).audit).toBe('198.51.100.8');
  });

  it('refuses a header that is not an address, even behind TRUSTED_PROXY', async () => {
    process.env.TRUSTED_PROXY = 'true';
    expect((await resolved({ 'x-real-ip': 'not-an-ip' })).audit).toBeNull();
    expect((await resolved({ 'x-forwarded-for': '999.999.999.999' })).audit).toBeNull();
  });

  it('leaves the audit field empty where the limiter uses a shared bucket', async () => {
    delete process.env.TRUSTED_PROXY;
    const seen = await resolved({});
    // A limiter needs SOME key, and one shared bucket for unidentifiable
    // callers is the safe reading. A record wants the field empty rather than
    // carrying a word the next person to query the table reads as an address.
    expect(seen.bucket).toBe('unknown');
    expect(seen.audit).toBeNull();
  });

  it('is what request-log actually writes', async () => {
    delete process.env.TRUSTED_PROXY;
    let written: Record<string, unknown> | undefined;
    // Captures the row instead of a database. `onAfterCommit` runs its callback
    // immediately when no tenant transaction is open, which is this test.
    const stub = {
      insertInto: () => ({
        values: (row: Record<string, unknown>) => ({
          execute: async () => {
            written = row;
            return [];
          },
        }),
      }),
    } as unknown as Database;

    const app = new Hono();
    app.use('*', requestLogMiddleware(stub));
    app.get('/api/things', (c) => c.text('ok'));
    await app.request('/api/things', { headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8' } });

    expect(written).toBeDefined();
    expect(written?.ip).toBeNull();
  });
});
