/**
 * Deep-health registry (TECHNICAL-GAPS 1.4) — the store behind `ctx.onHealthCheck`
 * + `/api/health/deep`/`:subsystem`.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  type HealthCheck,
  clearExtensionHealthChecks,
  getHealthCheck,
  listHealthChecks,
  registerHealthCheck,
  runHealthCheck,
  unregisterHealthCheck,
} from '../../lib/health-registry.js';

function reset(): void {
  for (const c of listHealthChecks()) unregisterHealthCheck(c.name);
}

describe('health-registry', () => {
  beforeEach(reset);

  it('registers, lists, and looks up a check with defaults', () => {
    registerHealthCheck('smtp', () => ({ ok: true }));
    expect(listHealthChecks().map((c) => c.name)).toEqual(['smtp']);
    const c = getHealthCheck('smtp');
    expect(c?.critical).toBe(false); // non-critical by default
  });

  it('honors the critical flag', () => {
    registerHealthCheck('core', () => ({ ok: true }), { critical: true });
    expect(getHealthCheck('core')?.critical).toBe(true);
  });

  it('runHealthCheck adds timing and passes through the result', async () => {
    registerHealthCheck('q', () => ({ ok: true, detail: { depth: 3 } }));
    const r = await runHealthCheck(getHealthCheck('q') as HealthCheck);
    expect(r.ok).toBe(true);
    expect(r.detail).toEqual({ depth: 3 });
    expect(typeof r.durationMs).toBe('number');
  });

  it('runHealthCheck is fail-closed: a throwing check becomes ok:false + error', async () => {
    registerHealthCheck('boom', () => {
      throw new Error('provider unreachable');
    });
    const r = await runHealthCheck(getHealthCheck('boom') as HealthCheck);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('provider unreachable');
  });

  it('awaits async checks', async () => {
    registerHealthCheck('async', async () => {
      await Bun.sleep(1);
      return { ok: false, error: 'still down' };
    });
    const r = await runHealthCheck(getHealthCheck('async') as HealthCheck);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('still down');
  });

  it('clearExtensionHealthChecks drops only the named extension namespace', () => {
    registerHealthCheck('ext:mail:smtp', () => ({ ok: true }));
    registerHealthCheck('ext:mail:imap', () => ({ ok: true }));
    registerHealthCheck('ext:crm:api', () => ({ ok: true }));
    registerHealthCheck('database', () => ({ ok: true }));

    clearExtensionHealthChecks('mail');

    const names = listHealthChecks()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(['database', 'ext:crm:api']);
  });

  it('re-registering the same name overwrites (hot-reload safety)', () => {
    registerHealthCheck('svc', () => ({ ok: true }));
    registerHealthCheck('svc', () => ({ ok: false, error: 'v2' }));
    expect(listHealthChecks()).toHaveLength(1);
  });
});
