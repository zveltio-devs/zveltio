/**
 * mapPgError — unique violation via message pattern without SQLSTATE code.
 */

import { describe, expect, it } from 'bun:test';
import { mapPgError } from '../../lib/data/write-pipeline.js';

describe('mapPgError — message-only unique violation', () => {
  it('maps duplicate key message without a code field', () => {
    const mapped = mapPgError({
      message: 'duplicate key value violates unique constraint "zvd_items_code_key"',
    });
    expect(mapped?.status).toBe(409);
    expect(mapped?.body.error).toBe('unique_violation');
  });

  it('maps not-null via message pattern with column fallback', () => {
    const mapped = mapPgError({
      message: 'null value in column "title" violates not-null constraint',
      column: 'title',
    });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.field).toBe('title');
  });
});
