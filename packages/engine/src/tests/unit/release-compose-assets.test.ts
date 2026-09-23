import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productionGuardViolations } from '../../lib/startup-guards.js';

/**
 * The compose files and the `.env` the installer writes are release assets —
 * nothing in CI started an engine from them, and v3.0.0-beta.67 shipped a
 * `docker-compose.yml` no YAML parser accepts, whose engine could not have
 * started anyway: its environment had no BETTER_AUTH_URL, which production
 * refuses to boot without.
 *
 * So this does what an operator does, minus Docker: generate the files, take
 * the `.env` exactly as `scripts/install.sh` writes it, interpolate the engine
 * service against it the way compose does, and hand the result to the same
 * guard the engine runs at boot.
 */

const ROOT = join(import.meta.dir, '../../../../..');
const OUT = mkdtempSync(join(tmpdir(), 'zv-compose-'));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

function run(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { cwd: OUT, env: { PATH: process.env.PATH ?? '' } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** The `.env` heredoc from install.sh, run with bash under `set -u`. */
function installerDotenv(): Record<string, string> {
  const src = readFileSync(join(ROOT, 'scripts/install.sh'), 'utf8');
  const m = src.match(/\n\s*cat > \.env << EOF\n([\s\S]*?)\nEOF\n/);
  if (!m) throw new Error('install.sh: `cat > .env << EOF` heredoc not found');
  const script = [
    'set -euo pipefail',
    'generate_secret() { openssl rand -hex "$1"; }',
    'VERSION=0.0.0-test DEFAULT_PORT=3000',
    'POSTGRES_PASS=$(generate_secret 32) SECRET_KEY=$(generate_secret 64)',
    'S3_SECRET=$(generate_secret 32) VALKEY_PASS=$(generate_secret 32)',
    'PUBLIC_URL=http://203.0.113.5:3000',
    `cat << EOF\n${m[1]}\nEOF`,
  ].join('\n');
  const env: Record<string, string> = {};
  for (const line of run(['bash', '-c', script]).split('\n')) {
    const kv = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (kv) env[kv[1]!] = kv[2]!;
  }
  return env;
}

/** Compose variable interpolation, for the forms the generator uses. */
function interpolate(value: unknown, env: Record<string, string>): string {
  return String(value)
    .replace(/\$\{([A-Z0-9_]+)(?:(:?[-?])([^}]*))?\}/g, (_, name, op, arg) => {
      const v = env[name];
      const unset = op?.startsWith(':') ? !v : v === undefined;
      if (op?.endsWith('?') && unset) throw new Error(`compose refuses: ${arg}`);
      if (op?.endsWith('-') && unset) return arg;
      return v ?? '';
    })
    .replace(/\$\$/g, '$');
}

type Compose = { services: { engine: { environment: Record<string, unknown> } } };

run(['bash', join(ROOT, 'scripts/generate-compose.sh'), '0.0.0-test', OUT]);
const dotenv = installerDotenv();

describe('release compose assets', () => {
  it.each(['docker-compose.yml', 'docker-compose.infra.yml', 'docker-compose.engine.yml'])(
    '%s is valid YAML',
    (file) => {
      expect(() => Bun.YAML.parse(readFileSync(join(OUT, file), 'utf8'))).not.toThrow();
    },
  );

  it.each(['docker-compose.yml', 'docker-compose.engine.yml'])(
    '%s engine, run on the installer .env, passes the production boot guard',
    (file) => {
      const doc = Bun.YAML.parse(readFileSync(join(OUT, file), 'utf8')) as Compose;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(doc.services.engine.environment)) {
        env[k] = interpolate(v, dotenv);
      }
      expect(env.NODE_ENV).toBe('production');
      expect(productionGuardViolations(env)).toEqual([]);
      // Not a boot failure, but every webhook create and every `encrypted: true`
      // write refuses without it.
      expect(env.FIELD_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  // Native mode: the compiled binary autoloads `.env` from its working
  // directory, so the installer .env alone must satisfy the guard.
  it('the installer .env alone passes the production boot guard (native mode)', () => {
    expect(dotenv.NODE_ENV).toBe('production');
    expect(productionGuardViolations(dotenv)).toEqual([]);
  });

  it('the default ZVELTIO_EXTENSIONS names only catalogued extensions', () => {
    const doc = Bun.YAML.parse(readFileSync(join(OUT, 'docker-compose.yml'), 'utf8')) as Compose;
    const names = interpolate(doc.services.engine.environment.ZVELTIO_EXTENSIONS, {}).split(',');
    const catalog = readFileSync(
      join(ROOT, 'packages/engine/src/lib/extensions/catalog.json'),
      'utf8',
    );
    const missing = names.filter((n) => !catalog.includes(`"name": "${n}"`));
    expect(missing).toEqual([]);
  });
});
