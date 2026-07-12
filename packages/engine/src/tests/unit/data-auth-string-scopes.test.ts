/**
 * checkAccess — API key scopes provided as a JSON string (lib/data/auth.ts).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { checkAccess } from '../../lib/data/auth.js';
import { CannedDb } from './fixtures/canned-db.js';

const db = new CannedDb().kysely as unknown as Database;

describe('checkAccess — stringified scopes', () => {
  afterEach(() => {
    // no mocks
  });

  it('parses scopes from a JSON string and enforces actions', async () => {
    const scopesJson = JSON.stringify([{ collection: 'articles', actions: ['read'] }]);
    const user = {
      id: 'apikey:k1',
      name: 'key',
      role: 'api_key' as const,
      scopes: scopesJson,
    };
    expect(await checkAccess(db, user, 'articles', 'read')).toBe(true);
    expect(await checkAccess(db, user, 'articles', 'delete')).toBe(false);
  });
});
