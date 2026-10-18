/**
 * checkAccess — API key scopes provided as a JSON string (lib/data/auth.ts).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import * as tenancy from '../../lib/tenancy/index.js';
import type { Database } from '../../db/index.js';
import { checkAccess } from '../../lib/data/auth.js';
import { CannedDb } from './fixtures/canned-db.js';

const db = new CannedDb().kysely as unknown as Database;

// The scope half is what this pins; the issuer half (`keyIssuerAllows`) grants.
beforeAll(() => {
  spyOn(tenancy, 'keyIssuerAllows').mockResolvedValue(true);
});
afterAll(() => {
  spyOn(tenancy, 'keyIssuerAllows').mockRestore();
});

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
