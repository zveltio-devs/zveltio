/**
 * mapPgError — additional SQLSTATE / message patterns (write-pipeline.ts).
 */

import { describe, expect, it } from 'bun:test';
import { mapPgError } from '../../lib/data/write-pipeline.js';

describe('mapPgError — extended codes', () => {
  it('maps 22P02 invalid input syntax', () => {
    const mapped = mapPgError({ code: '22P02', message: 'invalid input syntax for type uuid' });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.error).toBe('invalid_value');
  });

  it('maps 42703 undefined column', () => {
    const mapped = mapPgError({
      code: '42703',
      message: 'column "ghost_field" does not exist',
    });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.error).toBe('unknown_field');
  });

  it('maps foreign key via SQLSTATE 23503', () => {
    const mapped = mapPgError({
      code: '23503',
      message: 'insert or update on table violates foreign key constraint',
      constraint: 'fk_orders_customer',
    });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.error).toBe('foreign_key_violation');
  });
});
