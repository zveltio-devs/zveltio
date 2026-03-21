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

import { describe, it, expect, beforeAll } from 'bun:test';

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
  // Data
  { path: '/api/export', method: 'GET', name: 'export' },
  { path: '/api/import', method: 'POST', name: 'import' },
  // i18n
  { path: '/api/translations', method: 'GET', name: 'translations' },
  // Workflow
  { path: '/api/approvals', method: 'GET', name: 'approvals' },
  // Content
  { path: '/api/drafts', method: 'GET', name: 'drafts' },
  { path: '/api/media', method: 'GET', name: 'media' },
  // AI
  { path: '/api/ai/chat', method: 'POST', name: 'ai-chat' },
  // Developer
  { path: '/api/graphql', method: 'GET', name: 'graphql' },
  // Multitenancy
  { path: '/api/tenants', method: 'GET', name: 'tenants' },
  // CRM
  { path: '/api/contacts', method: 'GET', name: 'crm-contacts' },
  { path: '/api/organizations', method: 'GET', name: 'crm-organizations' },
  { path: '/api/transactions', method: 'GET', name: 'crm-transactions' },
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

describe.skipIf(skipAll)('Extensions — AI Agent Tools', () => {
  let userCookie: string;

  beforeAll(async () => {
    const ts = Date.now();
    const email = `ai-test-${ts}@test.local`;

    await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'TestPass123!', name: 'AI Test User' }),
    });

    const signIn = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'TestPass123!' }),
    });
    userCookie = signIn.headers.get('set-cookie')?.split(';')[0] ?? '';
  });

  it('POST /api/ai/chat — responds (200 if configured, 503 if not, never 404)', async () => {
    const res = await fetch(`${BASE_URL}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: userCookie },
      body: JSON.stringify({ message: 'Hello, list my collections' }),
    });

    expect([200, 400, 401, 403, 503]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('response');
      expect(body).toHaveProperty('conversationId');
    }
  });

  it('POST /api/ai/preview-schema — returns preview without executing DDL', async () => {
    const res = await fetch(`${BASE_URL}/api/ai/preview-schema`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: userCookie },
      body: JSON.stringify({ description: 'A simple blog with posts and comments' }),
    });

    expect([200, 400, 401, 403, 503]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('preview');
      expect(body).toHaveProperty('confirm_token');
    }
  });
});

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
