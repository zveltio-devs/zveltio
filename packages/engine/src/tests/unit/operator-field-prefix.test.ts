// The engine keeps its own copy of the operator field prefix (ADR 0012
// amendment 2): it imports no runtime value from the SDK, whose dist a binary
// build does not resolve. The CLI and Studio read the SDK's; the two must agree.
import { describe, expect, it } from 'bun:test';
import { OPERATOR_FIELD_PREFIX as sdk } from '@zveltio/sdk/extension';
import { OPERATOR_FIELD_PREFIX as engine } from '../../lib/data/index.js';

describe('OPERATOR_FIELD_PREFIX', () => {
  it("is the SDK's", () => expect(engine).toBe(sdk));
});
