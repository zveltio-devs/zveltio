import { describe, expect, it } from 'bun:test';

/**
 * `GET /api/admin/system/status` returned the literal string `'ok'` for
 * `status`, unconditionally — while reporting `database.status:
 * 'disconnected'` three lines below it in the same object. A status field that
 * cannot say anything else is not a status field, and it is the one an uptime
 * check reads.
 *
 * The table count had a second problem. It fell back to `'0'`, which reads as "a
 * database with no tables". Changing that to `'unknown'` looked right and was
 * not: the value is consumed as `parseInt(tableCount)`, and `parseInt('unknown')`
 * is NaN, which `JSON.stringify` renders as `null` — the honest answer arrived
 * by accident, through a path nobody chose and nothing tested.
 *
 * The shape of the decision is reproduced here rather than the route, which
 * needs a live app, a session and a cache.
 */
function statusBody(
  dbStatus: string,
  cacheStatus: string,
  tableCount: string | null,
  pgVersion: string,
) {
  const degraded = dbStatus !== 'connected' || cacheStatus === 'disconnected';
  return JSON.parse(
    JSON.stringify({
      status: degraded ? 'degraded' : 'ok',
      database: {
        status: dbStatus,
        version: pgVersion,
        tables: tableCount === null ? null : Number.parseInt(tableCount, 10),
      },
      cache: { status: cacheStatus },
    }),
  );
}

describe('system status says what is true', () => {
  it('is ok only when everything answered', () => {
    expect(statusBody('connected', 'connected', '113', 'PG 18').status).toBe('ok');
    expect(statusBody('connected', 'not_configured', '113', 'PG 18').status).toBe('ok');
  });

  it('does not report ok while the database is down', () => {
    // The whole defect in one assertion.
    const body = statusBody('disconnected', 'connected', null, 'unknown');
    expect(body.status).toBe('degraded');
    expect(body.database.status).toBe('disconnected');
  });

  it('degrades when the cache is down, which the old field could not express either', () => {
    expect(statusBody('connected', 'disconnected', '113', 'PG 18').status).toBe('degraded');
  });

  it('reports an uncountable table count as null, not as zero and not as NaN', () => {
    expect(statusBody('connected', 'connected', null, 'PG 18').database.tables).toBeNull();
    // `parseInt('unknown')` is NaN and JSON renders NaN as null — the same answer
    // for the wrong reason, and one a type change would have silently altered.
    expect(Number.isNaN(Number.parseInt('unknown', 10))).toBe(true);
  });

  it('still reports a real zero as zero', () => {
    // A database that genuinely has no base tables is a different fact from one
    // that could not be counted, and both have to survive the round trip.
    expect(statusBody('connected', 'connected', '0', 'PG 18').database.tables).toBe(0);
  });
});
