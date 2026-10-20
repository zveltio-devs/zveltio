import { describe, expect, test } from 'bun:test';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { toJsonb } from '../../lib/jsonb.js';

const db = new Kysely<unknown>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('toJsonb', () => {
  // An int8 column reads back as a bigint; a flow trigger carrying such a row
  // threw "BigInt value can't be serialized in JSON" before any step ran.
  test('serialises a bigint as its decimal string', () => {
    const { parameters } = toJsonb({ id: 9007199254740993n, n: [1n] }).compile(db);
    expect(parameters).toEqual(['{"id":"9007199254740993","n":["1"]}']);
  });
});
