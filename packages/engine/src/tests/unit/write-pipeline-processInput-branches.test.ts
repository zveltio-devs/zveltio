/**
 * processInput branches — unknown field types, validation errors, partial mode.
 */

import { describe, expect, it } from 'bun:test';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { fieldTypeRegistry } from '../../lib/data/index.js';
import { processInput } from '../../lib/data/write-pipeline.js';

registerCoreFieldTypes(fieldTypeRegistry);

const collectionDef = {
  name: 'items',
  fields: [
    { name: 'code', type: 'text', required: true, unique: false, indexed: false },
    { name: 'contact', type: 'email', required: false, unique: false, indexed: false },
    {
      name: 'ghost',
      type: 'not_a_registered_type',
      required: false,
      unique: false,
      indexed: false,
    },
  ],
} as never;

describe('processInput — branch coverage', () => {
  it('skips fields whose type is not registered in the field-type registry', async () => {
    const { errors, processed } = await processInput(
      { code: 'A', ghost: 'ignored' },
      collectionDef,
      false,
    );
    expect(errors).toEqual([]);
    expect(processed.code).toBe('A');
    expect(processed).not.toHaveProperty('ghost');
  });

  it('collects validation errors for invalid values in full replace mode', async () => {
    const { errors, processed } = await processInput(
      { code: 'A', contact: 'not-an-email' },
      collectionDef,
      false,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(processed.code).toBe('A');
  });

  it('validates only provided fields in partial (PATCH) mode', async () => {
    const { errors, processed } = await processInput({ code: 'patch-only' }, collectionDef, true);
    expect(errors).toEqual([]);
    expect(processed).toEqual({ code: 'patch-only' });
  });

  it('still validates a provided field in partial mode when the value is invalid', async () => {
    const { errors } = await processInput({ contact: 'bad' }, collectionDef, true);
    expect(errors.length).toBeGreaterThan(0);
  });
});
