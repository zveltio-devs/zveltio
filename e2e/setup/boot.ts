#!/usr/bin/env bun
/**
 * Bring up an engine the browser can actually drive.
 *
 * Playwright's `webServer` option starts one process. This suite needs three
 * things in a specific order — a fresh database, an engine that has migrated
 * it, and a god user to sign in as — so the orchestration lives here and
 * `webServer` just runs this.
 *
 * A FRESH database per run, dropped and recreated. Reusing one makes the first
 * failure of a run depend on what the previous run left behind, and the whole
 * value of driving a browser is that what it sees is what a new operator sees.
 *
 * The Studio is served from a build stamped with this engine's version. That is
 * not incidental: a mismatched `studio-dist` renders a blank admin page with no
 * diagnostic, an external audit lost its entire Studio pass to exactly that,
 * and a smoke suite booting against a stale bundle would reproduce the failure
 * it exists to detect.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { E2E } from './env.js';

const ROOT = join(import.meta.dir, '..', '..');
const PORT = E2E.port;
const DB_NAME = E2E.dbName;
const PG_ADMIN = E2E.pgAdminUrl;
const DB_URL = E2E.dbUrl;

async function psql(sql: string, url = PG_ADMIN): Promise<void> {
  const proc = Bun.spawn(['psql', url, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`psql failed: ${await new Response(proc.stderr).text()}`);
}

function engineEnv(): Record<string, string> {
  return {
    ...process.env,
    DATABASE_URL: DB_URL,
    PORT,
    BETTER_AUTH_URL: E2E.baseURL,
    BETTER_AUTH_SECRET: 'e2e-secret-at-least-32-characters-long',
    FIELD_ENCRYPTION_KEY: '0'.repeat(64),
    MAIL_ENCRYPTION_KEY: '0'.repeat(64),
    AI_KEY_ENCRYPTION_KEY: '0'.repeat(64),
    // The suite creates its own users through the API rather than seeding SQL,
    // so sign-up has to be reachable.
    ZVELTIO_REGISTRATION_ENABLED: '1',
    STUDIO_DIST_PATH: join(ROOT, 'packages', 'studio', 'dist'),
    NODE_ENV: 'test',
  } as Record<string, string>;
}

async function run(cmd: string[], env: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}`);
}

async function main(): Promise<void> {
  const env = engineEnv();

  if (!existsSync(env.STUDIO_DIST_PATH)) {
    throw new Error(
      `No Studio build at ${env.STUDIO_DIST_PATH}. Run \`cd packages/studio && bun x vite build\` ` +
        'first — this suite exists partly to catch a Studio that does not render, so it must ' +
        'not silently boot without one.',
    );
  }

  console.log(`[e2e] recreating ${DB_NAME}`);
  await psql(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await psql(`CREATE DATABASE ${DB_NAME}`);

  console.log('[e2e] migrating');
  await run(['bun', 'packages/engine/src/index.ts', 'migrate'], env);

  console.log('[e2e] creating the admin');
  await run(
    [
      'bun',
      'packages/engine/src/index.ts',
      'create-god',
      '--email',
      E2E.admin.email,
      '--password',
      E2E.admin.password,
    ],
    env,
  );

  console.log(`[e2e] starting engine on ${PORT}`);
  // Replace this process with the engine so Playwright's webServer sees one
  // long-running child and can signal it directly.
  const engine = spawn('bun', ['packages/engine/src/index.ts'], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  const stop = () => engine.kill('SIGTERM');
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  engine.on('exit', (code) => process.exit(code ?? 0));
}

if (import.meta.main) {
  await main();
}
