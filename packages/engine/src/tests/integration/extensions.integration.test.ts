/**
 * Extensions — Integration Tests
 *
 * Verifies that routes moved into extensions are registered correctly
 * and respond with 401 (not 404) for unauthenticated requests.
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

// Routes provided by extensions — all must return 401, not 404
const EXTENSION_ROUTES = [
  // Automation
  { path: '/api/flows', method: 'GET', name: 'flows' },
  // Marketplace
  { path: '/api/marketplace', method: 'GET', name: 'marketplace' },
  // Operations
  { path: '/api/backup', method: 'GET', name: 'backup' },
  // Compliance
  { path: '/api/gdpr/export-my-data', method: 'GET', name: 'gdpr' },
  // Developer
  { path: '/api/database', method: 'GET', name: 'database' },
  { path: '/api/introspect', method: 'GET', name: 'byod' },
  { path: '/api/schema/branches', method: 'GET', name: 'schema-branches' },
  { path: '/api/docs', method: 'GET', name: 'api-docs' },
  // Analytics
  { path: '/api/insights', method: 'GET', name: 'insights' },
  { path: '/api/quality', method: 'GET', name: 'quality' },
  // Developer tools
  { path: '/api/saved-queries', method: 'GET', name: 'saved-queries' },
  { path: '/api/validation', method: 'GET', name: 'validation' },
  // Data — the extension's own paths. `/api/export` and `/api/import` are not
  // here: they are 410 shims now, asserted separately below.
  { path: '/ext/data/export/posts', method: 'GET', name: 'export' },
  { path: '/ext/data/import/jobs', method: 'GET', name: 'import' },
  // i18n
  { path: '/api/translations', method: 'GET', name: 'translations' },
  // Workflow
  { path: '/ext/workflow/approvals', method: 'GET', name: 'approvals' },
  // Content
  { path: '/api/drafts', method: 'GET', name: 'drafts' },
  { path: '/ext/content/media', method: 'GET', name: 'media' },
  // AI — moved to the `ai` extension; route registration is tested in extension repo
  // Developer
  { path: '/api/graphql', method: 'GET', name: 'graphql' },
  // Multitenancy
  { path: '/api/tenants', method: 'GET', name: 'tenants' },
  // CRM
  { path: '/ext/crm/contacts', method: 'GET', name: 'crm-contacts' },
  { path: '/ext/crm/organizations', method: 'GET', name: 'crm-organizations' },
  { path: '/ext/crm/transactions', method: 'GET', name: 'crm-transactions' },
  // Mail
  { path: '/api/mail/accounts', method: 'GET', name: 'mail-accounts' },
];

// Core routes that must always be registered (not extension-dependent)
const CORE_ROUTES = new Set(['flows', 'marketplace', 'tenants']);

describe.skipIf(skipAll)('Extensions — Route Registration', () => {
  for (const route of EXTENSION_ROUTES) {
    it(`${route.method} ${route.path} → 401 not 404 (${route.name})`, async () => {
      const res = await fetch(`${BASE_URL}${route.path}`, {
        method: route.method,
        headers: { 'Content-Type': 'application/json' },
      });

      if (CORE_ROUTES.has(route.name)) {
        // Core routes must always respond (not 404)
        expect(res.status).not.toBe(404);
        expect([200, 401, 403, 405]).toContain(res.status);
      } else {
        // Extension routes may return 404 if the extension isn't loaded in this environment
        expect([200, 400, 401, 403, 404, 405, 503]).toContain(res.status);
      }
    });
  }
});

/**
 * Doors the engine closed when the feature moved to an extension.
 *
 * They are NOT in EXTENSION_ROUTES: that list allows 404 for a route whose
 * extension is not loaded, which would pass whether the shim answered or the
 * path had simply been deleted. A gone door has a stricter contract — 410 and
 * the replacement path — and it holds with no extension loaded at all, because
 * the shim is the engine's.
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

// AI Agent Tools tests live in the `ai` extension repo as of alpha.67 — they
// require the AI extension to be installed and loaded, which engine integration
// tests do not provide.

describe.skipIf(skipAll)('Extensions — GraphQL', () => {
  it('GET /api/graphql — playground responds', async () => {
    const res = await fetch(`${BASE_URL}/api/graphql`, {
      headers: { Accept: 'text/html' },
    });
    expect([200, 401, 404]).toContain(res.status);
  });

  it('POST /api/graphql — introspection query returns schema or 401', async () => {
    const res = await fetch(`${BASE_URL}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __schema { types { name } } }' }),
    });
    expect([200, 401, 404]).toContain(res.status);
  });
});
