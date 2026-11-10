import { describe, expect, it } from 'bun:test';
import { WebhookPatchSchema } from '../../routes/webhooks.js';

describe('PATCH /api/webhooks/:id', () => {
  it('writes only the fields it names, never a default over a stored value', () => {
    expect(WebhookPatchSchema.parse({ url: 'https://example.com/hook' })).toEqual({
      url: 'https://example.com/hook',
    });
  });
});
