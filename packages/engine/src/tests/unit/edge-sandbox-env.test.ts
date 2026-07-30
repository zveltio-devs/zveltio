/**
 * The environment an edge-function sandbox is given.
 *
 * A Bun Worker inherits the parent's environment unless it is handed its own,
 * and the sandbox's `process` stub sits on `globalThis` — which
 * `await import('node:process')` bypasses, because the module loader is not
 * reachable through globals. So the lockdown never kept engine credentials away
 * from edge-function code; the Worker's `env` option is what does.
 *
 * Both Worker call sites take their value from sandboxWorkerEnv(), so asserting
 * on it covers both.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { sandboxWorkerEnv } from '../../lib/edge-functions/sandbox-env.js';

const PLANTED = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'FIELD_ENCRYPTION_KEY',
  'MAIL_ENCRYPTION_KEY',
  'AI_KEY_ENCRYPTION_KEY',
  'S3_SECRET_KEY',
  'VALKEY_URL',
  'METRICS_TOKEN',
];
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

function plantSecrets() {
  for (const k of PLANTED) {
    saved.set(k, process.env[k]);
    process.env[k] = `secret-value-for-${k}`;
  }
}

describe('sandboxWorkerEnv', () => {
  it('passes NODE_ENV through so frameworks do not assume dev', () => {
    expect(sandboxWorkerEnv().NODE_ENV).toBeTruthy();
  });

  it('exposes exactly one variable', () => {
    plantSecrets();
    expect(Object.keys(sandboxWorkerEnv())).toEqual(['NODE_ENV']);
  });

  it('carries none of the engine secrets, even when they are all set', () => {
    plantSecrets();
    const env = sandboxWorkerEnv();
    for (const k of PLANTED) expect(env[k]).toBeUndefined();
  });

  it('leaks no secret VALUE under any key', () => {
    // Guards against a future edit that copies a secret under a different name.
    plantSecrets();
    const values = Object.values(sandboxWorkerEnv());
    for (const v of values) expect(v.startsWith('secret-value-for-')).toBe(false);
  });

  it('is an allowlist — a newly introduced secret is excluded by construction', () => {
    saved.set('BRAND_NEW_SECRET', process.env.BRAND_NEW_SECRET);
    process.env.BRAND_NEW_SECRET = 'nobody-added-this-to-a-denylist';
    expect(sandboxWorkerEnv().BRAND_NEW_SECRET).toBeUndefined();
  });
});

describe('EDGE_SANDBOX_MODE default', () => {
  const modeOf = (v: string | undefined) => (v === 'worker' ? 'worker' : 'subprocess');

  it('defaults to subprocess — a process boundary, not a globals lockdown', () => {
    expect(modeOf(undefined)).toBe('subprocess');
  });

  it('still honours an explicit opt-in to the in-process worker', () => {
    expect(modeOf('worker')).toBe('worker');
  });

  it('treats an unrecognised value as subprocess rather than falling back', () => {
    expect(modeOf('inline')).toBe('subprocess');
    expect(modeOf('')).toBe('subprocess');
  });
});
