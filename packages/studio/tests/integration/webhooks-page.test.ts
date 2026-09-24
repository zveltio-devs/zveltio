import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The webhooks page, mounted against a live engine.
 *
 * Its unit sibling hands the page one hand-written row, so it cannot notice
 * that `GET /api/webhooks` wraps the list in `{ webhooks }`, that creation
 * answers `{ webhook, secret }` with the plaintext shown exactly once, or that
 * a row lost a column the table prints. The secret is the reason this page is
 * worth a lane of its own: the plaintext never comes back after creation, so
 * every field around it has to be right the first time.
 */
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/webhooks') } }));

import { api, webhooksApi } from '$lib/api.js';
import Page from '../../src/routes/(admin)/webhooks/+page.svelte';

const MASK = '••••••••';
const NAME = `it_webhook_${Date.now().toString(36)}`;
let id: string | undefined;
let plaintextSecret: string | undefined;

beforeAll(async () => {
  const created = await api.post<{ webhook: { id: string }; secret: string }>('/api/webhooks', {
    name: NAME,
    url: 'https://example.com/integration-hook',
    method: 'POST',
    events: ['data.create'],
    active: true,
  });
  id = created.webhook?.id;
  plaintextSecret = created.secret;
});

afterAll(async () => {
  if (id) await api.delete(`/api/webhooks/${id}`).catch(() => {});
});

afterEach(cleanup);

describe('webhooks — against the engine', () => {
  it('renders a webhook the engine actually holds', async () => {
    render(Page);
    await waitFor(() => expect(document.body.textContent).toContain(NAME));
  });

  it('creation is the only time the plaintext secret is sent', async () => {
    expect(plaintextSecret, 'POST /api/webhooks stopped returning the plaintext').toBeTruthy();
    expect(plaintextSecret).not.toBe(MASK);

    const one = await webhooksApi.get(id as string);
    expect(one.webhook.secret, 'GET returned something other than the mask').toBe(MASK);

    const list = await webhooksApi.list();
    const mine = list.find((w: { id: string }) => w.id === id);
    expect(mine, 'the created webhook is missing from the list').toBeDefined();
    expect(mine.secret).toBe(MASK);
  });

  it('a row carries the fields the table prints', async () => {
    const list = await webhooksApi.list();
    const mine = list.find((w: { id: string }) => w.id === id) as Record<string, unknown>;
    for (const key of [
      'id',
      'name',
      'url',
      'method',
      'events',
      'active',
      'retry_attempts',
      'timeout',
    ]) {
      expect(mine, `webhook row lost ${key}`).toHaveProperty(key);
    }
    expect(Array.isArray(mine.events)).toBe(true);
  });

  it('editing only the URL leaves the rest of the row alone', async () => {
    const updated = await webhooksApi.update(id as string, {
      url: 'https://example.com/integration-hook-2',
    });
    expect(updated.webhook.url).toBe('https://example.com/integration-hook-2');
    expect(updated.webhook.name).toBe(NAME);
    expect(updated.webhook.events).toEqual(['data.create']);
    expect(updated.webhook.secret).toBe(MASK);
  });

  it('the delivery list the page opens answers for a webhook with no deliveries', async () => {
    const { deliveries } = await webhooksApi.deliveries(id as string);
    expect(Array.isArray(deliveries)).toBe(true);
  });

  it('refuses a URL pointing at the host it runs on', async () => {
    await expect(
      api.post('/api/webhooks', {
        name: `${NAME}_ssrf`,
        url: 'http://127.0.0.1:3399/api/collections',
        method: 'POST',
        events: ['data.create'],
      }),
      // Any 400 satisfied a bare `toThrow()`: a payload the schema refused
      // for another reason read as the SSRF guard working.
    ).rejects.toThrow(/internal\/private address/);
  });
});
