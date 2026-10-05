/**
 * The `Bun.SQL` quirks the engine answers in db/bun-sql-quirks.ts.
 *
 * Each case is the shape a driver really produces. When upstream fixes a quirk,
 * the case that pins it is the one to change — and then the workaround goes.
 */

import { describe, expect, it } from 'bun:test';
import { isRecoverableDbError, sqlState } from '../../db/bun-sql-quirks.js';

describe('sqlState', () => {
  it('reads errno on Bun.SQL, where code is a generic marker', () => {
    expect(sqlState({ code: 'ERR_POSTGRES_SERVER_ERROR', errno: '23505' })).toBe('23505');
  });

  it('reads code on node-postgres, which sets no errno', () => {
    expect(sqlState({ code: '42P01' })).toBe('42P01');
  });

  it('is empty for a Node system error, a non-SQLSTATE marker, or no error', () => {
    expect(sqlState({ errno: -32, code: 'EPIPE' })).toBe('');
    expect(sqlState({ code: 'ERR_POSTGRES_SERVER_ERROR' })).toBe('');
    expect(sqlState(new Error('plain'))).toBe('');
    expect(sqlState(null)).toBe('');
    expect(sqlState(undefined)).toBe('');
  });
});

describe('isRecoverableDbError', () => {
  it('survives a connection the pool already closed', () => {
    expect(isRecoverableDbError({ code: 'ERR_POSTGRES_CONNECTION_CLOSED' })).toBe(true);
    expect(isRecoverableDbError(new Error('Connection closed'))).toBe(true);
  });

  it("survives Bun.SQL's synchronous throw when the socket dies mid-transaction", () => {
    expect(isRecoverableDbError(new Error('connection must be a PostgresSQLConnection'))).toBe(
      true,
    );
  });

  it('survives a WebSocket peer going away', () => {
    expect(isRecoverableDbError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRecoverableDbError({ code: 'EPIPE' })).toBe(true);
  });

  it('stops on anything else, a database error included', () => {
    expect(isRecoverableDbError(new TypeError('x is undefined'))).toBe(false);
    expect(isRecoverableDbError({ code: 'ERR_POSTGRES_SERVER_ERROR', errno: '23505' })).toBe(false);
    expect(isRecoverableDbError(undefined)).toBe(false);
  });
});
