/**
 * A key principal with no `zv_api_keys` row — an extension job's
 * `apikey:job:<ext>:<job>` — is refused wherever the key's row id is read off
 * the principal, instead of slicing a fake id out of it.
 */

import { describe, expect, it } from 'bun:test';
import { apiKeyRowId, realtimeIdentity } from '../../lib/data/index.js';
import { mayReadFile } from '../../lib/media-visibility.js';

const KEY = '0b7c2c55-34a1-4a8e-9d6e-8f2b1c3d4e5f';
const JOB = 'apikey:job:shop:restock';
const TENANT = '00000000-0000-0000-0000-000000000001';

describe('apiKeyRowId', () => {
  it('answers the row of a real key', () => {
    expect(apiKeyRowId(`apikey:${KEY}`)).toBe(KEY);
  });

  it('refuses a key principal with no row', () => {
    for (const id of [JOB, 'apikey:', `apikey:${KEY}x`, KEY]) {
      expect(() => apiKeyRowId(id)).toThrow('not backed by an API key row');
    }
  });

  it('is what the media owner check and the realtime door read', () => {
    const file = { tenant_id: TENANT, visibility: 'personal', created_by_api_key: KEY };
    expect(mayReadFile(file, `apikey:${KEY}`, false, TENANT)).toBe(true);
    expect(() => mayReadFile(file, JOB, false, TENANT)).toThrow('not backed by an API key row');
    const job = { user: { id: JOB, name: 'j', role: 'api_key' }, authType: 'api_key' } as never;
    expect(() => realtimeIdentity(job)).toThrow('not backed by an API key row');
  });
});
