import { describe, expect, it } from 'bun:test';
import { encodeArrayParams } from '../../db/bun-sql-dialect.js';

describe('encodeArrayParams', () => {
  it('leaves non-array params alone', () => {
    expect(encodeArrayParams([1, 'a', null, { a: 1 }])).toEqual([1, 'a', null, { a: 1 }]);
  });

  it('quotes and escapes 1-D elements, NULL for null/undefined', () => {
    expect(encodeArrayParams([['a,"b"', null, 'c\\d', undefined]])).toEqual([
      '{"a,\\"b\\"",NULL,"c\\\\d",NULL}',
    ]);
  });

  it('nests arrays as a multidimensional literal', () => {
    expect(
      encodeArrayParams([
        [
          [1, 2],
          [3, 4],
        ],
      ]),
    ).toEqual(['{{"1","2"},{"3","4"}}']);
  });

  it('sends object elements as JSON text, so jsonb[] holds objects', () => {
    expect(encodeArrayParams([[{ a: 'x"y' }]])).toEqual(['{"{\\"a\\":\\"x\\\\\\"y\\"}"}']);
  });

  it('sends Date as ISO and Buffer as bytea hex', () => {
    expect(encodeArrayParams([[new Date(0), Buffer.from('hi')]])).toEqual([
      '{"1970-01-01T00:00:00.000Z","\\\\x6869"}',
    ]);
  });
});
