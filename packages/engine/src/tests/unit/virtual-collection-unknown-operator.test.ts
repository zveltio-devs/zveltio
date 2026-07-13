/**
 * virtual-collection-adapter.ts — translateQuery default branch for unknown operators.
 */

import { describe, expect, it } from 'bun:test';
import {
  translateQuery,
  type VirtualConfig,
  type VirtualQuery,
} from '../../lib/virtual-collection-adapter.js';

const cfg: VirtualConfig = {
  source_url: 'https://api.example.com',
  auth_type: 'none',
  field_mapping: {},
  list_path: '$.data',
  id_field: 'id',
};

const query: VirtualQuery = {
  page: 1,
  limit: 10,
  filters: [{ field: 'status', op: 'contains', value: 'open' }],
};

describe('translateQuery — unknown operator passthrough', () => {
  it('appends custom operator keys when supported_operators is unset', () => {
    const qs = translateQuery(cfg, query);
    expect(new URLSearchParams(qs).get('status[contains]')).toBe('open');
  });
});
