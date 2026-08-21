/**
 * Gone shims for routes that moved to extensions.
 *
 * Keeping a live dual implementation next to `/ext/<name>` was the failure
 * mode documented in content/media CONTEXT: audits fixed the engine copy while
 * Studio called the extension. A 410 with the replacement path is louder than
 * silent drift, and safer than a proxy that keeps two owners.
 */
import { Hono } from 'hono';

export function goneRoutes(replacement: string, feature: string): Hono {
  const app = new Hono();
  app.all('*', (c) =>
    c.json(
      {
        error: `${feature} moved to an extension. Use ${replacement} instead of this /api path.`,
        replacement,
      },
      410,
    ),
  );
  return app;
}
