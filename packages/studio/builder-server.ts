/**
 * Studio Builder Server — runs inside the `studio-builder` Docker container.
 *
 * Receives a POST /rebuild from the engine (when STUDIO_BUILDER_URL is set),
 * copies extension pages into the SvelteKit route tree, runs `bun run build`,
 * and writes the dist to the shared volume.
 *
 * GET /health — liveness probe for Docker healthcheck.
 */

import { Hono } from 'hono';
import { cpSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const app = new Hono();

const STUDIO_ROOT = import.meta.dir;
const EXT_DIR = process.env.EXTENSIONS_DIR ?? '/extensions';
const ROUTES_EXT = join(STUDIO_ROOT, 'src/routes/(admin)/extensions');

app.get('/health', (c) => c.json({ ok: true }));

app.post('/rebuild', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { extensions?: string[] };
  const activeExtensions: string[] = body.extensions ?? [];

  // Sync extension pages into Studio route tree
  let synced = 0;
  for (const extName of activeExtensions) {
    const pagesDir = join(EXT_DIR, extName, 'studio', 'pages');
    if (!existsSync(pagesDir)) continue;

    let slug = extName;
    const manifestPath = join(EXT_DIR, extName, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const m = JSON.parse(await Bun.file(manifestPath).text()) as {
          studio?: { pages?: Array<{ path: string }> };
        };
        const firstPage = m.studio?.pages?.[0];
        if (firstPage?.path) {
          slug = firstPage.path.replace(/^\/admin\//, '').replace(/^\//, '');
        }
      } catch {
        /* use extName as slug */
      }
    }

    const dest = join(ROUTES_EXT, slug);
    mkdirSync(dest, { recursive: true });
    cpSync(pagesDir, dest, { recursive: true });
    synced++;
  }

  // Run vite build
  const proc = Bun.spawn(['bun', 'run', 'build'], {
    cwd: STUDIO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, SKIP_SYNC_EXT: '1' }, // skip prebuild sync — we just did it above
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    console.error('[builder] Build failed:\n', stderr);
    return c.json({ rebuilt: false, error: stderr.slice(0, 500) }, 500);
  }

  console.log(`[builder] Studio rebuilt (${synced} extension(s) synced).`);
  return c.json({ rebuilt: true, synced });
});

const port = Number(process.env.BUILDER_PORT ?? 3001);
console.log(`[builder] Listening on :${port}`);
export default { port, fetch: app.fetch };
