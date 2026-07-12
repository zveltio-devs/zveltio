/**
 * CollectionSchema — remaining snake_case aliases (ddl-manager.ts).
 */

import { describe, expect, it } from 'bun:test';
import { CollectionSchema } from '../../lib/data/index.js';

const TEXT = { name: 'title', type: 'text', required: true, unique: false, indexed: false };

describe('CollectionSchema snake_case aliases', () => {
  it('normalizes route_group, is_permissioned, schema_locked, and ai_search flags', () => {
    const parsed = CollectionSchema.parse({
      name: 'docs',
      route_group: 'public',
      is_permissioned: false,
      is_managed: true,
      is_system: false,
      schema_locked: true,
      ai_search_enabled: true,
      ai_search_field: 'body',
      fields: [TEXT],
    });
    expect(parsed.routeGroup).toBe('public');
    expect(parsed.isPermissioned).toBe(false);
    expect(parsed.isManaged).toBe(true);
    expect(parsed.isSystem).toBe(false);
    expect(parsed.schemaLocked).toBe(true);
    expect(parsed.aiSearchEnabled).toBe(true);
    expect(parsed.aiSearchField).toBe('body');
  });
});
