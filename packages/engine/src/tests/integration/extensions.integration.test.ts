/**
 * Extensions — Integration Tests
 *
 * What an unauthenticated caller meets at the doors around the extension
 * system: the engine's own routes, the `/ext/*` mount, and the 410 shims left
 * where a feature moved out.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test \
 *   packages/engine/src/tests/integration/extensions.integration.test.ts
 */

import { describe, it, expect } from 'bun:test';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

// Engine-owned routes: always mounted, so exactly 401 — a 404 means the route
// is gone, a 200 means it answers strangers.
//
// This list used to accept 200 and 404 for anything not marked "core", and ten
// of its paths (`/api/database`, `/api/graphql`, `/api/translations`, …) no
// longer exist anywhere: they passed on 404 every run, asserting nothing.
const ENGINE_ROUTES = [
  '/api/flows',
  '/api/marketplace',
  '/api/backup',
  '/api/schema/branches',
  '/api/insights',
  '/api/saved-queries',
  '/api/tenants',
];

describe.skipIf(skipAll)('Engine routes — closed without a session', () => {
  for (const path of ENGINE_ROUTES) {
    it(`GET ${path} → 401`, async () => {
      const res = await fetch(`${BASE_URL}${path}`);
      expect(res.status).toBe(401);
    });
  }
});

// Extension paths answer 401 whether or not the extension is loaded: the
// `/ext/*` gate runs before routing, so an unknown extension is refused the
// same way. That is the guarantee worth pinning — a stranger learns nothing,
// not even which extensions are installed. It does NOT prove the extension's
// routes are registered; marketplace-lifecycle does that with a real install.
const EXT_PATHS = [
  '/ext/data/export/posts',
  '/ext/data/import/jobs',
  '/ext/workflow/approvals',
  '/ext/content/media',
  '/ext/crm/contacts',
  '/ext/no-such-extension/anything',
];

describe.skipIf(skipAll)('/ext/* — closed without a session, loaded or not', () => {
  for (const path of EXT_PATHS) {
    it(`GET ${path} → 401`, async () => {
      const res = await fetch(`${BASE_URL}${path}`);
      expect(res.status).toBe(401);
    });
  }
});

/**
 * Doors the engine closed when the feature moved to an extension.
 *
 * A gone door has its own contract — 410 and the replacement path — and it
 * holds with no extension loaded at all, because the shim is the engine's.
 */
const GONE_DOORS = [
  { path: '/api/export/posts', method: 'GET', replacement: '/ext/data/export' },
  { path: '/api/import/jobs', method: 'GET', replacement: '/ext/data/import' },
  { path: '/api/media/folders', method: 'GET', replacement: '/ext/content/media' },
  { path: '/api/approvals', method: 'GET', replacement: '/ext/workflow/approvals' },
  { path: '/api/briefing', method: 'GET', replacement: '/ext/crm/briefing' },
];

describe.skipIf(skipAll)('Extensions — closed doors', () => {
  for (const door of GONE_DOORS) {
    it(`${door.method} ${door.path} → 410 pointing at ${door.replacement}`, async () => {
      const res = await fetch(`${BASE_URL}${door.path}`, { method: door.method });
      expect(res.status).toBe(410);
      const body = (await res.json()) as { errors?: { replacement?: string } };
      expect(body.errors?.replacement).toBe(door.replacement);
    });
  }
});
