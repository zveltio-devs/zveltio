/**
 * An extension's built documents, `GET /api/extensions/<name>/ui/<file>` (ADR 0038
 * decisions 3, 4).
 *
 * Served from `<extDir>/ui/` while the extension is loaded and active for the
 * caller's firm; otherwise 404, the answer an absent extension gets. No session is
 * asked: a front end on another origin frames the document cross-site, where no
 * cookie rides, and a sandboxed document's module scripts arrive with
 * `Origin: null`, which never authenticates (decision 11). The document holds no
 * authority of its own — that is what the policy below is for.
 */
import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Context } from 'hono';
import type { Database } from '../../db/index.js';
import { activeForRequest } from './activation.js';
import { extensionLoader } from './extension-loader.js';

/**
 * Decision 4: an opaque origin even when the URL is opened directly (`sandbox`
 * without `allow-same-origin`), and no network — its own files, `data:` and
 * `blob:` only, `connect-src 'none'`, no form submission anywhere.
 */
export function extensionUiCsp(own: string): string {
  const src = `${own} data: blob:`;
  return [
    "default-src 'none'",
    `script-src ${src} 'unsafe-inline'`,
    `style-src ${src} 'unsafe-inline'`,
    `img-src ${src}`,
    `font-src ${src}`,
    `media-src ${src}`,
    `worker-src ${src}`,
    `frame-src ${src}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    'sandbox allow-scripts allow-forms',
  ].join('; ');
}

/** `<name>` (one or two segments) and the file path under `ui/`, or null. */
function splitUiPath(rest: string): { name: string; file: string[] } | null {
  const parts = rest.split('/');
  // Scoped names first, as `extensionNameCandidates` does.
  for (const n of [2, 1]) {
    if (parts[n] !== 'ui') continue;
    const name = parts.slice(0, n).join('/');
    if (extensionLoader.isActive(name)) return { name, file: parts.slice(n + 1) };
  }
  return null;
}

export function serveExtensionUi(db: Database) {
  return async (c: Context): Promise<Response> => {
    const notFound = () => c.json({ error: 'Not found' }, 404);
    const hit = splitUiPath(c.req.path.slice('/api/extensions/'.length));
    if (!hit) return notFound();
    const { name, file } = hit;
    if (file.length === 0 || file.some((s) => !s || s === '.' || s === '..' || /[\\\0]/.test(s))) {
      return notFound();
    }
    const extDir = extensionLoader.extDirs.get(name);
    if (!extDir || !(await activeForRequest(c, name, db))) return notFound();

    // A symlink in the archive must not reach outside `ui/`.
    const root = await realpath(join(extDir, 'ui')).catch(() => null);
    const path = await realpath(join(extDir, 'ui', ...file)).catch(() => null);
    if (!root || !path?.startsWith(root + sep)) return notFound();
    if (!(await stat(path)).isFile()) return notFound();
    const body = Bun.file(path);

    const own = `${new URL(c.req.url).host}/api/extensions/${name}/ui/`;
    return new Response(body, {
      headers: {
        'Content-Type': body.type,
        'Content-Security-Policy': extensionUiCsp(own),
        'X-Content-Type-Options': 'nosniff',
        // The document's module scripts and fonts are CORS requests from an opaque origin.
        'Access-Control-Allow-Origin': '*',
        // Revalidated, so a disabled extension stops showing.
        'Cache-Control': 'no-cache',
      },
    });
  };
}
