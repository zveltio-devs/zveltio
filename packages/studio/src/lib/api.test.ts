/**
 * The Studio's API client — specifically its error envelope.
 *
 * Every page in the Studio surfaces failures through this one path, so what it
 * extracts from a response body is what an administrator reads when something
 * goes wrong. The fallback chain (`detail → title → error → message → status`)
 * exists because the engine emits RFC 9457 problem+json while some routes still
 * answer with `{ error }` from before H-13. If the chain regresses, nothing
 * crashes — every message in the product quietly degrades to "Request failed:
 * 500", which is the least useful true thing it could say.
 *
 * `code`, `status` and `traceId` are carried on the thrown Error because
 * callers branch on them: a 409 renders differently from a 500, and the traceId
 * is what makes an operator's report matchable to a log line.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * The shape the client attaches to a thrown error. Narrowed once here rather
 * than cast at every assertion — the point of the tests is these fields.
 */
type ApiError = Error & { code?: string; status?: number; traceId?: string };

/** Read a rejection as the client's error shape. */
function asApiError(e: unknown): ApiError {
  if (!(e instanceof Error)) throw new Error(`Not an Error: ${String(e)}`);
  return e as ApiError;
}

/** Stub `fetch` with one response. */
function respond(status: number, body: unknown, ok = status < 400) {
  globalThis.fetch = vi.fn(
    async () =>
      ({
        ok,
        status,
        json: async () => body,
      }) as unknown as Response,
  );
}

/** A body that cannot be parsed — an HTML error page from a proxy, say. */
function respondUnparseable(status: number) {
  globalThis.fetch = vi.fn(
    async () =>
      ({
        ok: false,
        status,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      }) as unknown as Response,
  );
}

describe('api — successful responses', () => {
  it('returns the parsed body', async () => {
    respond(200, { records: [{ id: 'a' }] });
    const out = await api.get<{ records: { id: string }[] }>('/api/data/x');
    expect(out.records[0]!.id).toBe('a');
  });

  it('sends credentials so the session cookie travels', async () => {
    // Without this every request is anonymous and the Studio looks logged out.
    respond(200, {});
    await api.get('/api/data/x');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/data/x'),
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

describe('api — the error envelope', () => {
  it('prefers problem+json detail', async () => {
    respond(403, {
      type: 'about:blank',
      title: 'Forbidden',
      detail: 'You are not a member of this tenant.',
      code: 'tenant.membership_required',
    });

    const err = asApiError(await api.get('/api/data/x').catch((e) => e));
    expect(err.message).toBe('You are not a member of this tenant.');
  });

  it('falls back to title when there is no detail', async () => {
    respond(403, { title: 'Forbidden', code: 'forbidden' });
    const err = asApiError(await api.get('/api/data/x').catch((e) => e));
    expect(err.message).toBe('Forbidden');
  });

  it('still reads a legacy { error } body', async () => {
    // Routes that predate H-13 answer this way. Dropping the fallback would
    // turn every one of their messages into the status line.
    respond(400, { error: 'target_folder_id required' });
    const err = asApiError(await api.get('/api/x').catch((e) => e));
    expect(err.message).toBe('target_folder_id required');
  });

  it('reads { message } as the last body shape', async () => {
    respond(400, { message: 'Bad input' });
    const err = asApiError(await api.get('/api/x').catch((e) => e));
    expect(err.message).toBe('Bad input');
  });

  it('falls back to the status when the body says nothing', async () => {
    respond(500, {});
    const err = asApiError(await api.get('/api/x').catch((e) => e));
    expect(err.message).toBe('Request failed: 500');
  });

  it('does not throw a parse error when the body is not JSON', async () => {
    // A gateway returning an HTML 502 must surface as "Request failed: 502",
    // not as a SyntaxError from deep inside the client — which would hide the
    // real failure behind a confusing one.
    respondUnparseable(502);
    const err = asApiError(await api.get('/api/x').catch((e) => e));
    expect(err.message).toBe('Request failed: 502');
    expect(err).toBeInstanceOf(Error);
  });

  it('carries code, status and traceId for callers that branch on them', async () => {
    respond(409, {
      detail: 'Extension is published.',
      code: 'LISTING_FROZEN',
      traceId: 'abc-123',
    });

    const err = asApiError(await api.get('/api/x').catch((e) => e));
    expect(err.status).toBe(409);
    expect(err.code).toBe('LISTING_FROZEN');
    expect(err.traceId).toBe('abc-123');
  });

  it('prefers detail over title when both are present', async () => {
    // Ordering is the whole point of the chain: `title` is the status name
    // ("Forbidden"), `detail` is what actually happened.
    respond(403, { title: 'Forbidden', detail: 'Writing requires the "traceability" permission.' });
    const err = asApiError(await api.get('/api/x').catch((e) => e));
    expect(err.message).toContain('traceability');
  });
});
