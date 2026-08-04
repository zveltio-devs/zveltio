/**
 * A preview token travels in a header, never in a query string.
 *
 * The middleware used to accept `?_preview=` as well. A query string is the one
 * place a credential must not go: proxies, CDNs and load balancers log them by
 * default, browsers keep them in history, and they ride along in Referer to
 * every third party the page touches. A header does none of that, and the
 * header form already existed.
 *
 * Checked rather than assumed before removing it — `?_preview=` appeared in no
 * documentation and had no consumer in the SDK, client, CLI or Studio, and this
 * middleware is mounted on `/api/data/*`, which nothing navigates to. The
 * earlier decision to keep it rested on "shared preview links", which turned
 * out not to exist.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { previewEnvMiddleware } from '../../middleware/preview-env.js';
import { CannedDb } from './fixtures/canned-db.js';

const SCHEMA = 'branch_feature_x';

function db(): CannedDb {
  const d = new CannedDb();
  d.when(/FROM zv_schema_branches/i, [{ preview_schema: SCHEMA, preview_expires_at: null }]);
  return d;
}

/** Minimal Hono context: a token in the header, the query, or neither. */
function ctx(opts: { header?: string; query?: string }) {
  const vars = new Map<string, unknown>();
  return {
    req: {
      header: (n: string) => (n === 'x-preview-token' ? opts.header : undefined),
      query: (n: string) => (n === '_preview' ? opts.query : undefined),
    },
    set: (k: string, v: unknown) => vars.set(k, v),
    get: (k: string) => vars.get(k),
    _vars: vars,
    // biome-ignore lint/suspicious/noExplicitAny: minimal context stand-in
  } as any;
}

describe('preview-env middleware', () => {
  it('applies the branch schema when the token arrives in the header', async () => {
    const d = db();
    const c = ctx({ header: 'tok-1' });
    await previewEnvMiddleware(d.kysely as unknown as Database)(c, async () => {});
    expect(c._vars.get('previewSchema')).toBe(SCHEMA);
  });

  it('ignores a token in the query string', async () => {
    // The whole finding. This used to switch the request onto the branch
    // schema, which meant the credential that did it was sitting in every
    // access log between the client and here.
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = db();
      const c = ctx({ query: 'tok-1' });
      await previewEnvMiddleware(d.kysely as unknown as Database)(c, async () => {});
      expect(c._vars.get('previewSchema')).toBeUndefined();
      // Never even looked the token up.
      expect(d.executed(/FROM zv_schema_branches/i)).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('says so out loud rather than ignoring it silently', async () => {
    // A credential quietly dropped is a debugging session; one that names its
    // replacement is a fix.
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await previewEnvMiddleware(db().kysely as unknown as Database)(
        ctx({ query: 'tok-1' }),
        async () => {},
      );
      const said = warn.mock.calls.map((a) => String(a[0])).join('\n');
      expect(said).toContain('X-Preview-Token');
    } finally {
      warn.mockRestore();
    }
  });

  it('passes straight through when there is no token at all', async () => {
    const d = db();
    let reached = false;
    await previewEnvMiddleware(d.kysely as unknown as Database)(ctx({}), async () => {
      reached = true;
    });
    expect(reached).toBe(true);
    expect(d.executed(/FROM zv_schema_branches/i)).toHaveLength(0);
  });

  it('prefers the header even when a query token is also present', async () => {
    const d = db();
    const c = ctx({ header: 'tok-header', query: 'tok-query' });
    await previewEnvMiddleware(d.kysely as unknown as Database)(c, async () => {});
    const looked = d.executed(/FROM zv_schema_branches/i)[0];
    expect(looked?.parameters).toContain('tok-header');
    expect(looked?.parameters).not.toContain('tok-query');
  });
});
