/**
 * Gone shims for routes that moved to extensions.
 *
 * Keeping a live dual implementation next to `/ext/<name>` was the failure
 * mode documented in content/media CONTEXT: audits fixed the engine copy while
 * Studio called the extension. Throw `problem()` so the envelope keeps a stable
 * `errors.replacement` under the /api problemNormalizer.
 */
import { Hono } from 'hono';
import { problem } from '../lib/problem.js';

export function goneRoutes(replacement: string, feature: string): Hono {
  const app = new Hono();
  app.all('*', () => {
    throw problem(
      'gone',
      410,
      `${feature} moved to an extension. Use ${replacement} instead of this /api path.`,
      { replacement },
    );
  });
  return app;
}
