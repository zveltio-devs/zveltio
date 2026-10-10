import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fly.io, Railway and Render run one container built from the repository's
 * Dockerfile, and production loads third-party extensions only through the
 * extension runner (RFC extension-runner, step 9). The runner drops every
 * extension to a uid of its own, which needs root, so the image those platforms
 * build must start as root and start the runner beside the engine
 * (docker/zveltio-entrypoint.sh, proven in docker by
 * scripts/ext-runner-standalone.sh). The image the chart and the release
 * compose pull must keep its numeric non-root user.
 */

const ROOT = join(import.meta.dir, '../../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Each stage of the Dockerfile: its name and its USER / ENTRYPOINT lines. */
function stages(): Array<{ name: string; from: string; user?: string; entrypoint?: string }> {
  const out: Array<{ name: string; from: string; user?: string; entrypoint?: string }> = [];
  for (const line of read('Dockerfile').split('\n')) {
    const from = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) out.push({ from: from[1]!, name: from[2] ?? '' });
    const cur = out.at(-1);
    const user = line.match(/^USER\s+(\S+)/);
    if (cur && user) cur.user = user[1];
    const ep = line.match(/^ENTRYPOINT\s+(.+)/);
    if (cur && ep) cur.entrypoint = ep[1];
  }
  return out;
}

describe('one-container image (Fly.io, Railway, Render, docker build .)', () => {
  it('the default target starts as root, on the production stage and its entrypoint', () => {
    const all = stages();
    const last = all.at(-1)!;
    const production = all.find((s) => s.name === 'production')!;
    expect(last.from).toBe('production');
    // A name: Fly.io's init resolves the user through /etc/passwd.
    expect(last.user).toBe('root');
    expect(production.entrypoint).toBe('["/usr/local/bin/zveltio-entrypoint"]');
    expect(read('Dockerfile')).toContain(
      'COPY docker/zveltio-entrypoint.sh /usr/local/bin/zveltio-entrypoint',
    );
  });

  it('the published image keeps the numeric non-root user the chart relies on', () => {
    expect(stages().find((s) => s.name === 'production')!.user).toBe('100:101');
    expect(read('.github/workflows/release.yml')).toMatch(
      /docker buildx build[\s\S]{0,200}--target production/,
    );
  });

  it('the entrypoint starts the runner only as root, for `start`, and drops the engine', () => {
    const sh = read('docker/zveltio-entrypoint.sh');
    expect(sh).toMatch(
      /\nif \[ "\$\(id -u\)" != 0 \] \|\| \[ "\$\{1:-start\}" != start \]; then exec "\$BIN" "\$@"; fi\n/,
    );
    expect(sh).toContain('--bounding-set=-all,+setuid,+setgid,+kill');
    expect(sh).toMatch(/env -i PATH="\$PATH" NODE_ENV=/);
    expect(sh).toMatch(/exec setpriv --reuid=100 --regid=101 [^\n]*--bounding-set=-all/);
    // PID 1 reaps the orphans of a runner that died.
    expect(sh).toMatch(/--no-new-privs -- \/sbin\/tini -- "\$BIN" "\$@"\n/);
    expect(read('Dockerfile')).toMatch(/apk add --no-cache [^\n]*\btini\b/);
  });

  it('each platform builds that default target and leaves its user and command alone', () => {
    const fly = read('fly.toml');
    expect(fly).toMatch(/\[build\]\s*\n(?:\s*#.*\n)*\s*dockerfile = "Dockerfile"/);
    expect(fly).not.toMatch(/build-target|\bcmd\b|entrypoint|\buser\b/);

    const railway = JSON.parse(read('railway.json'));
    expect(railway.build).toEqual({ builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' });
    // `bun dist/index.js` started nothing: the image has no such file.
    expect(railway.deploy.startCommand).toBeUndefined();

    const render = read('render.yaml');
    expect(render).toContain('dockerfilePath: ./Dockerfile');
    expect(render).not.toMatch(/dockerCommand|dockerTarget/);
  });
});

/**
 * A fresh deploy from each file must pass the production guard
 * (lib/startup-guards.ts) with only what the file, the image and the platform
 * set, plus the secrets the operator is told to provide. Before this, none of
 * the three set VALKEY_URL or ZVELTIO_SINGLE_INSTANCE, so the first boot failed
 * the guard on every platform.
 */
describe('a fresh PaaS deploy passes the production guard', () => {
  /** ENV lines of the stages the default target inherits (production, standalone). */
  function imageEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    let inChain = false;
    for (const line of read('Dockerfile').split('\n')) {
      const from = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
      if (from) inChain = from[2] === 'production' || from[2] === 'standalone';
      const set = line.match(/^ENV\s+([A-Z_]+)=(\S*)/);
      if (inChain && set) env[set[1]!] = set[2]!.replace(/^"|"$/g, '');
    }
    return env;
  }

  /** `KEY = "value"` lines of fly.toml's [env] table. */
  function flyEnv(): Record<string, string> {
    const table = read('fly.toml').match(/\n\[env\]\n([\s\S]*?)(?:\n\[|$)/)?.[1] ?? '';
    return Object.fromEntries(
      [...table.matchAll(/^\s*([A-Z_]+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1]!, m[2]!]),
    );
  }

  /** render.yaml envVars of the web service: literal values, and keys the platform fills. */
  function renderEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    const doc = read('render.yaml');
    for (const m of doc.matchAll(/- key: ([A-Z_]+)\n((?:\s{8,}.*\n)*)/g)) {
      const body = m[2]!;
      const value = body.match(/^\s+value: "?([^"\n]*)"?$/m)?.[1];
      // generateValue, fromDatabase and sync: false (asked at blueprint creation)
      // are all set before the first boot.
      env[m[1]!] =
        value ?? (/generateValue: true|fromDatabase:|sync: false/.test(body) ? 'set' : '');
    }
    return env;
  }

  // What every platform supplies or the docs tell the operator to set as a secret.
  const secrets = { DATABASE_URL: 'postgres://u@h/db', BETTER_AUTH_SECRET: 'x'.repeat(32) };

  it('Fly.io', async () => {
    const { productionGuardViolations } = await import('../../lib/startup-guards.js');
    expect(productionGuardViolations({ ...imageEnv(), ...flyEnv(), ...secrets })).toEqual([]);
  });

  it('Render', async () => {
    const { productionGuardViolations } = await import('../../lib/startup-guards.js');
    expect(productionGuardViolations({ ...imageEnv(), ...renderEnv(), ...secrets })).toEqual([]);
    expect(read('render.yaml')).toMatch(/numInstances: 1\n/);
    expect(read('render.yaml')).toMatch(/postgresMajorVersion: "18"/);
  });

  it('Railway (railway.json carries no variables; BETTER_AUTH_URL is the documented one)', async () => {
    const { productionGuardViolations } = await import('../../lib/startup-guards.js');
    const v = productionGuardViolations({ ...imageEnv(), ...secrets });
    expect(v.map((x) => x.variable)).toEqual(['BETTER_AUTH_URL']);
    expect(read('docs/platform/deployment.md')).toMatch(
      /BETTER_AUTH_URL=https:\/\/\$\{\{RAILWAY_PUBLIC_DOMAIN\}\}/,
    );
    expect(JSON.parse(read('railway.json')).deploy.numReplicas).toBe(1);
  });

  it('the image declares one instance only for itself: Valkey turns the mode off', async () => {
    const { singleInstanceMode } = await import('../../lib/runtime/single-instance.js');
    expect(imageEnv().ZVELTIO_SINGLE_INSTANCE).toBe('1');
    expect(singleInstanceMode({ ...imageEnv(), VALKEY_URL: 'redis://c:6379' })).toBe(false);
    // The published image (chart, release compose) does not get it.
    const prod = read('Dockerfile').split(/^FROM production AS standalone$/m)[0]!;
    expect(prod).not.toContain('ZVELTIO_SINGLE_INSTANCE');
  });
});
