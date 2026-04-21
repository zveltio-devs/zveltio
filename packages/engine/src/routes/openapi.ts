import { Hono } from 'hono';
import { ENGINE_VERSION } from '../version.js';

export function openApiRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const spec = buildSpec();
    return c.json(spec);
  });

  return app;
}

function buildSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Zveltio Engine API',
      version: ENGINE_VERSION,
      description: 'The BaaS that just works — single binary, extensions, no complexity.',
      contact: { url: 'https://zveltio.com' },
    },
    servers: [{ url: '/api', description: 'Engine API' }],
    security: [{ cookieAuth: [] }, { apiKey: [] }],
    paths: {
      // ── Health ─────────────────────────────────────────────────────────────
      '/health': {
        get: {
          tags: ['Health'],
          summary: 'Health check',
          security: [],
          responses: {
            '200': { description: 'Engine is healthy', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['ok', 'degraded'] }, timestamp: { type: 'string' } } } } } },
            '503': { description: 'Engine is degraded' },
          },
        },
      },
      '/health/version': {
        get: {
          tags: ['Health'],
          summary: 'Engine version and schema info (auth required)',
          responses: {
            '200': { description: 'Version info' },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      // ── Auth ───────────────────────────────────────────────────────────────
      '/auth/sign-up/email': {
        post: {
          tags: ['Auth'],
          summary: 'Register new user',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['email', 'password', 'name'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 }, name: { type: 'string' } } } } },
          },
          responses: {
            '200': { description: 'User created', content: { 'application/json': { schema: { type: 'object', properties: { user: { type: 'object' }, token: { type: 'string' } } } } } },
          },
        },
      },
      '/auth/sign-in/email': {
        post: {
          tags: ['Auth'],
          summary: 'Sign in with email and password',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } } } } },
          },
          responses: {
            '200': { description: 'Signed in — session cookie set in response' },
            '401': { description: 'Invalid credentials' },
          },
        },
      },
      '/auth/get-session': {
        get: {
          tags: ['Auth'],
          summary: 'Get current session',
          responses: {
            '200': { description: 'Session + user object' },
            '401': { description: 'Not authenticated' },
          },
        },
      },
      '/auth/sign-out': {
        post: {
          tags: ['Auth'],
          summary: 'Sign out (invalidates session cookie)',
          responses: { '200': { description: 'Signed out' } },
        },
      },

      // ── Collections ────────────────────────────────────────────────────────
      '/collections': {
        get: {
          tags: ['Collections'],
          summary: 'List all collections (admin)',
          responses: {
            '200': { description: 'Collections list', content: { 'application/json': { schema: { type: 'object', properties: { collections: { type: 'array', items: { type: 'object' } } } } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
        post: {
          tags: ['Collections'],
          summary: 'Create a collection (admin) — async DDL',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' }, fields: { type: 'array', items: { type: 'object', required: ['name', 'type'], properties: { name: { type: 'string' }, type: { type: 'string' }, required: { type: 'boolean' } } } } } } } },
          },
          responses: {
            '202': { description: 'DDL job queued', content: { 'application/json': { schema: { type: 'object', properties: { job_id: { type: 'string' }, status: { type: 'string' } } } } } },
            '400': { description: 'Invalid input' },
          },
        },
      },
      '/collections/{name}': {
        get: {
          tags: ['Collections'],
          summary: 'Get collection schema',
          parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Collection schema' }, '404': { description: 'Not found' } },
        },
        delete: {
          tags: ['Collections'],
          summary: 'Delete a collection and all its data (admin)',
          parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Deleted' }, '404': { description: 'Not found' } },
        },
      },

      // ── Data CRUD ──────────────────────────────────────────────────────────
      '/data/{collection}': {
        get: {
          tags: ['Data'],
          summary: 'List records',
          parameters: [
            { name: 'collection', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 500 } },
            { name: 'sort', in: 'query', schema: { type: 'string' }, description: 'Field name to sort by' },
            { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
            { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Full-text search' },
            { name: 'filter', in: 'query', schema: { type: 'string' }, description: 'JSON filter: {"field":{"op":value}} — ops: eq, neq, gt, gte, lt, lte, like, in, not_in, null, not_null' },
            { name: 'field[op]', in: 'query', schema: { type: 'string' }, description: 'Bracket filter (alternative to JSON): ?price[gt]=50&title[like]=pro' },
            { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Cursor for keyset pagination (base64url from next_cursor)' },
            { name: 'as_of', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Time-travel: reconstruct state at this timestamp' },
          ],
          responses: {
            '200': {
              description: 'Records list',
              content: { 'application/json': { schema: { type: 'object', properties: { records: { type: 'array', items: { $ref: '#/components/schemas/Record' } }, pagination: { $ref: '#/components/schemas/Pagination' }, next_cursor: { type: 'string', nullable: true } } } } },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden — no read policy for this collection' },
          },
        },
        post: {
          tags: ['Data'],
          summary: 'Create a record',
          parameters: [{ name: 'collection', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
          responses: {
            '201': { description: 'Created record', content: { 'application/json': { schema: { $ref: '#/components/schemas/Record' } } } },
            '400': { description: 'Validation error' },
            '403': { description: 'Forbidden — no create policy' },
          },
        },
      },
      '/data/{collection}/{id}': {
        get: {
          tags: ['Data'],
          summary: 'Get a single record',
          parameters: [
            { name: 'collection', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'Record', content: { 'application/json': { schema: { $ref: '#/components/schemas/Record' } } } }, '404': { description: 'Not found' } },
        },
        patch: {
          tags: ['Data'],
          summary: 'Update a record (partial)',
          parameters: [
            { name: 'collection', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
          responses: { '200': { description: 'Updated record' }, '403': { description: 'Forbidden — no update policy' }, '404': { description: 'Not found' } },
        },
        delete: {
          tags: ['Data'],
          summary: 'Delete a record',
          parameters: [
            { name: 'collection', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'Deleted' }, '403': { description: 'Forbidden — no delete policy' }, '404': { description: 'Not found' } },
        },
      },

      // ── Permissions ────────────────────────────────────────────────────────
      '/permissions/policies': {
        post: {
          tags: ['Permissions'],
          summary: 'Add a Casbin policy (admin)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['subject', 'resource', 'action'], properties: { subject: { type: 'string', description: 'User ID or role name' }, resource: { type: 'string', description: 'Collection name (e.g. "products") or system resource (e.g. "admin")' }, action: { type: 'string', description: 'read | create | update | delete | *' } } } } },
          },
          responses: { '200': { description: 'Policy added' }, '401': { description: 'Unauthorized' } },
        },
        delete: {
          tags: ['Permissions'],
          summary: 'Remove a Casbin policy (admin)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['subject', 'resource', 'action'], properties: { subject: { type: 'string' }, resource: { type: 'string' }, action: { type: 'string' } } } } },
          },
          responses: { '200': { description: 'Policy removed' } },
        },
      },
      '/permissions/roles': {
        post: {
          tags: ['Permissions'],
          summary: 'Assign a Casbin role to a user (admin)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['userId', 'role'], properties: { userId: { type: 'string' }, role: { type: 'string' } } } } },
          },
          responses: { '200': { description: 'Role assigned' } },
        },
        delete: {
          tags: ['Permissions'],
          summary: 'Remove a Casbin role from a user (admin)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['userId', 'role'], properties: { userId: { type: 'string' }, role: { type: 'string' } } } } },
          },
          responses: { '200': { description: 'Role removed' } },
        },
      },
      '/permissions/bootstrap': {
        post: {
          tags: ['Permissions'],
          summary: 'Emergency: promote user to god role',
          description: 'Requires `Authorization: Bearer <RECOVERY_TOKEN>` header. Only available when RECOVERY_TOKEN env var is set (min 32 chars).',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } },
          },
          responses: { '200': { description: 'User promoted to god role' }, '401': { description: 'Invalid token' }, '403': { description: 'Recovery mode not enabled' }, '404': { description: 'User not found' } },
        },
      },

      // ── Users ──────────────────────────────────────────────────────────────
      '/users': {
        get: {
          tags: ['Users'],
          summary: 'List users (admin)',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Users list' }, '401': { description: 'Unauthorized' } },
        },
      },

      // ── Webhooks ───────────────────────────────────────────────────────────
      '/webhooks': {
        get: { tags: ['Webhooks'], summary: 'List webhooks (admin)', responses: { '200': { description: 'Webhooks list' } } },
        post: {
          tags: ['Webhooks'],
          summary: 'Create a webhook (admin)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['name', 'url', 'events'], properties: { name: { type: 'string' }, url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string', enum: ['insert', 'update', 'delete'] } }, collections: { type: 'array', items: { type: 'string' } }, secret: { type: 'string' } } } } },
          },
          responses: { '201': { description: 'Webhook created' } },
        },
      },

      // ── Settings ───────────────────────────────────────────────────────────
      '/settings': {
        get: { tags: ['Settings'], summary: 'Get all settings', responses: { '200': { description: 'Settings object' } } },
        patch: {
          tags: ['Settings'],
          summary: 'Update a single setting (admin)',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { key: { type: 'string' }, value: {} } } } } },
          responses: { '200': { description: 'Updated' } },
        },
      },

      // ── Storage ────────────────────────────────────────────────────────────
      '/storage': {
        get: { tags: ['Storage'], summary: 'List files', responses: { '200': { description: 'Files list' } } },
        post: {
          tags: ['Storage'],
          summary: 'Upload a file',
          requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, collection: { type: 'string' }, record_id: { type: 'string' } } } } } },
          responses: { '201': { description: 'File uploaded' } },
        },
      },
    },
    components: {
      responses: {
        Unauthorized: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        Forbidden: { description: 'Insufficient permissions', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
        Pagination: { type: 'object', properties: { total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' }, pages: { type: 'integer' } } },
        Record: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' }, status: { type: 'string' } }, additionalProperties: true },
      },
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    },
  };
}
