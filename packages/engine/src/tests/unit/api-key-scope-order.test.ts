/**
 * An API key's scopes are a union of grants, not a first-match lookup.
 *
 * `checkAccess` used `scopes.find(...)`: the first entry naming the collection
 * or `*` decided the answer by itself, so a broad read grant listed above a
 * specific write grant silently cancelled it, and the same two entries in the
 * other order allowed the write.
 */

import { describe, expect, it } from 'bun:test';
import { checkAccess } from '../../lib/data/auth.js';
import type { RequestUser } from '../../lib/data/types.js';

const key = (scopes: unknown): RequestUser =>
  ({ id: 'apikey:test', name: 'k', role: 'api_key', scopes }) as RequestUser;
const db = null as never;

const WILDCARD_READ = { collection: '*', actions: ['read'] };
const POSTS_CREATE = { collection: 'posts', actions: ['create'] };

describe('api key scope matching', () => {
  it('grants a specific action listed after a broader entry', async () => {
    expect(await checkAccess(db, key([WILDCARD_READ, POSTS_CREATE]), 'posts', 'create')).toBe(true);
  });

  it('does not depend on the order the grants were written in', async () => {
    expect(await checkAccess(db, key([POSTS_CREATE, WILDCARD_READ]), 'posts', 'create')).toBe(true);
  });

  it('still refuses an action no entry grants', async () => {
    expect(await checkAccess(db, key([WILDCARD_READ, POSTS_CREATE]), 'posts', 'delete')).toBe(
      false,
    );
  });

  it('still refuses a collection no entry names', async () => {
    expect(await checkAccess(db, key([POSTS_CREATE]), 'invoices', 'create')).toBe(false);
  });

  it('an empty scope list is still deny-all', async () => {
    expect(await checkAccess(db, key([]), 'posts', 'read')).toBe(false);
  });
});
