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

  it('encodes the storage folder into the query string', async () => {
    const urls = captureUrls();
    const client = createZveltioClient({ baseUrl: 'https://engine.test' });
    await client.storage.list('invoices&limit=9999');
    expect(urls).toEqual(['https://engine.test/api/storage?folder=invoices%26limit%3D9999']);
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
