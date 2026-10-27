import { describe, it, expect, afterEach } from 'bun:test';
import { createZveltioClient } from '../client.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records the URL each call is given and answers `{}` without a network hop. */
function captureUrls(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return urls;
}

describe('ZveltioClient URL building', () => {
  it('encodes a record id into a single path segment', async () => {
    const urls = captureUrls();
    const client = createZveltioClient({ baseUrl: 'https://engine.test' });
    const products = client.collection('products');
    await products.get('a/b');
    await products.update('a/b', { name: 'x' });
    await products.delete('a/b');
    expect(urls).toEqual([
      'https://engine.test/api/data/products/a%2Fb',
      'https://engine.test/api/data/products/a%2Fb',
      'https://engine.test/api/data/products/a%2Fb',
    ]);
  });

  it('asks the engine who its key is at the route that answers it', async () => {
    const urls = captureUrls();
    const client = createZveltioClient({ baseUrl: 'https://engine.test', apiKey: 'zvk_x' });
    await client.auth.apiKey();
    expect(urls).toEqual(['https://engine.test/api/api-keys/self']);
  });

  it("reaches the member's own keys at /api/me/api-keys", async () => {
    const urls = captureUrls();
    const client = createZveltioClient({ baseUrl: 'https://engine.test' });
    await client.auth.apiKeys.list();
    await client.auth.apiKeys.revoke('a/b');
    expect(urls).toEqual([
      'https://engine.test/api/me/api-keys',
      'https://engine.test/api/me/api-keys/a%2Fb',
    ]);
  });

  it('encodes the storage folder into the query string', async () => {
    const urls = captureUrls();
    const client = createZveltioClient({ baseUrl: 'https://engine.test' });
    await client.storage.list('invoices&limit=9999');
    expect(urls).toEqual(['https://engine.test/api/storage?folder_id=invoices%26limit%3D9999']);
  });

  it('sends the upload folder under the field name the engine reads', async () => {
    let body: FormData | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = init?.body as FormData;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = createZveltioClient({ baseUrl: 'https://engine.test' });
    await client.storage.upload(new File(['x'], 'a.txt'), 'folder-uuid');
    expect(body?.get('folder_id')).toBe('folder-uuid');
    expect(body?.has('folder')).toBe(false);
  });

  it('leaves an ordinary id and collection name untouched', async () => {
    const urls = captureUrls();
    const client = createZveltioClient({ baseUrl: 'https://engine.test/' });
    await client.collection('order_items').get('018f2a1e-0000-7000-8000-000000000000');
    expect(urls).toEqual([
      'https://engine.test/api/data/order_items/018f2a1e-0000-7000-8000-000000000000',
    ]);
  });
});

describe('ZveltioClient session token (bearer mode)', () => {
  function engine(issue: string | null) {
    const sent: Array<{ auth: string | null; credentials?: RequestCredentials }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        auth: new Headers(init?.headers).get('Authorization'),
        credentials: init?.credentials,
      });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (issue) headers['set-auth-token'] = issue;
      return new Response('{}', { status: 200, headers });
    }) as typeof fetch;
    return sent;
  }

  it('captures the token at sign-in, sends it as a bearer, and forgets it on logout', async () => {
    const seen: Array<string | null> = [];
    const sent = engine('tok.sig');
    const client = createZveltioClient({
      baseUrl: 'https://engine.test',
      onSessionToken: (t) => seen.push(t),
    });
    await client.auth.login('a@b.c', 'pw');
    const next = engine(null);
    await client.collection('products').list();
    await client.auth.logout();
    await client.collection('products').list();
    expect(sent[0]).toEqual({ auth: null, credentials: 'omit' });
    expect(next.map((s) => s.auth)).toEqual(['Bearer tok.sig', 'Bearer tok.sig', null]);
    expect(seen).toEqual(['tok.sig', null]);
    expect(client.getSessionToken()).toBeNull();
  });

  it('a browser client keeps cookies and ignores an issued token', async () => {
    const sent = engine('tok.sig');
    const client = createZveltioClient({ baseUrl: 'https://engine.test' });
    await client.auth.login('a@b.c', 'pw');
    await client.collection('products').list();
    expect(sent.map((s) => [s.auth, s.credentials])).toEqual([
      [null, 'include'],
      [null, 'include'],
    ]);
  });
});

describe('ZveltioClient step-up', () => {
  function engine() {
    const sent: Array<string | null> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const token = new Headers(init?.headers).get('X-Zveltio-Step-Up');
      sent.push(token);
      if (token === 'su-1') return new Response('{"ok":true}', { status: 200 });
      return new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          code: 'step_up_required',
          errors: { action: 'config' },
        }),
        { status: 403, headers: { 'content-type': 'application/problem+json' } },
      );
    }) as typeof fetch;
    return sent;
  }

  it('asks for a step-up on 403 step_up_required and sends once more with the token', async () => {
    const sent = engine();
    const asked: string[] = [];
    const client = createZveltioClient({
      baseUrl: 'https://engine.test',
      onStepUpRequired: async (action) => {
        asked.push(action);
        return 'su-1';
      },
    });
    expect(await client.post<{ ok: boolean }>('/api/collections', { name: 'x' })).toEqual({
      ok: true,
    });
    expect(asked).toEqual(['config']);
    expect(sent).toEqual([null, 'su-1']);
  });

  it('throws the 403 when the hook gives up, and without a hook', async () => {
    const sent = engine();
    const giveUp = createZveltioClient({
      baseUrl: 'https://engine.test',
      onStepUpRequired: async () => null,
    });
    await expect(giveUp.post('/api/collections', {})).rejects.toMatchObject({
      code: 'step_up_required',
    });
    const plain = createZveltioClient({ baseUrl: 'https://engine.test' });
    await expect(plain.post('/api/collections', {})).rejects.toMatchObject({
      code: 'step_up_required',
    });
    expect(sent).toEqual([null, null]);
  });
});
