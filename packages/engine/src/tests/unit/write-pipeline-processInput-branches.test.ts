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
  /**
   * This asserted `errors: []` — that an unresolvable field type is silently
   * skipped — and that assertion was the defect. The field was never validated
   * and never copied, so the value the caller sent was dropped and the write
   * still answered 201. Reading the record back showed the column empty, with
   * nothing anywhere saying why.
   *
   * It matters because extensions REGISTER field types. Disable the extension
   * that owns one and every column of that type quietly stops accepting data on
   * a collection that still declares it — indistinguishable from a user who left
   * the field blank.
   */
  it('refuses a field whose type the registry cannot resolve, instead of dropping the value', async () => {
    const { errors, processed } = await processInput(
      { code: 'A', ghost: 'ignored' },
      collectionDef,
      false,
    );
    expect(errors).toEqual([
      'ghost: unknown field type "not_a_registered_type" — the extension that provides it may not be enabled',
    ]);
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
