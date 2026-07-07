/**
 * H-14 fault-injection fixtures.
 *
 * Real failure injection needs an engine booted with fault-configured env
 * (a dead S3 endpoint, a registry pointed at a mock that fails mid-download),
 * which the shared CI integration engine can't provide — so these spawn a
 * throwaway engine on an ephemeral port and drive it over HTTP, asserting DB
 * state via a direct connection.
 */

import { join } from 'node:path';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';

const ENGINE_ROOT = join(import.meta.dir, '..', '..', '..'); // packages/engine

export interface SpawnedEngine {
  baseUrl: string;
  cookie: string;
  godEmail: string;
  proc: Bun.Subprocess;
  stop: () => void;
  logs: () => Promise<string>;
}

/**
 * Boot a throwaway engine with extra env, wait for health, create a god admin
 * (via a direct DB promote so the hash matches the runtime), and sign in.
 */
export async function spawnEngine(opts: {
  port: number;
  dbUrl: string;
  extraEnv?: Record<string, string>;
}): Promise<SpawnedEngine> {
  const { port, dbUrl, extraEnv = {} } = opts;
  const baseUrl = `http://127.0.0.1:${port}`;

  const proc = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: ENGINE_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      BETTER_AUTH_SECRET: 'ci-test-secret-minimum-32-characters-long',
      BETTER_AUTH_URL: baseUrl,
      FIELD_ENCRYPTION_KEY: '0'.repeat(64),
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* not ready */
    }
    if (proc.exitCode !== null) break;
    await Bun.sleep(1000);
  }
  const logs = async () =>
    `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
  if (!up) {
    proc.kill();
    throw new Error(`spawned engine on :${port} never came up`);
  }

  const godEmail = `fault-${port}-${Date.now()}@test.local`;
  const password = 'FaultPass123!';
  await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: godEmail, password, name: 'Fault Admin' }),
  });
  const db = createDb(dbUrl);
  await sql`UPDATE "user" SET role = 'god' WHERE email = ${godEmail}`.execute(db);
  // biome-ignore lint/suspicious/noExplicitAny: Kysely destroy is untyped on the alias
  await (db as any).destroy?.();

  const signin = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: godEmail, password }),
  });
  const cookie = (signin.headers.get('set-cookie') ?? '').split(';')[0];

  return { baseUrl, cookie, godEmail, proc, stop: () => proc.kill(), logs };
}

export interface MockRegistry {
  url: string;
  downloadHits: () => number;
  stop: () => void;
}

/**
 * A registry that serves a catalog containing `extName` but FAILS the tarball
 * download — the faithful "registry down mid-install" fault: the catalog
 * resolves, then the download dies, exercising the install's cleanup path.
 */
export function startMockRegistry(extName: string): MockRegistry {
  let downloadHits = 0;
  const server = Bun.serve({
    port: 0, // ephemeral
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/extensions/list') {
        return Response.json({
          extensions: [
            {
              name: extName,
              display_name: 'Fault Probe',
              description: 'registry-down probe',
              category: 'other',
              version: '1.0.0',
              is_official: true,
            },
          ],
        });
      }
      if (url.pathname.includes('/download')) {
        downloadHits++;
        return new Response('registry exploded mid-download', { status: 500 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    downloadHits: () => downloadHits,
    stop: () => server.stop(true),
  };
}

/** Terminate every backend a role/app currently holds — the mid-flight kill. */
export async function terminateBackend(killer: Database, pid: number): Promise<void> {
  await sql`SELECT pg_terminate_backend(${pid})`.execute(killer);
}
