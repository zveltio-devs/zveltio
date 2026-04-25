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
          summary: 'Create a webhook — signing secret auto-generated if omitted',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['name', 'url', 'events'], properties: { name: { type: 'string' }, url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string', enum: ['insert', 'update', 'delete', '*'] } }, collections: { type: 'array', items: { type: 'string' } }, secret: { type: 'string', description: 'HMAC-SHA256 signing secret. Omit to auto-generate a 32-byte secret. Plaintext returned only once.' }, method: { type: 'string', enum: ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'], default: 'POST' }, retry_attempts: { type: 'integer', minimum: 0, maximum: 10, default: 3 }, timeout: { type: 'integer', default: 5000, description: 'Request timeout in ms' }, headers: { type: 'object', additionalProperties: { type: 'string' } } } } } },
          },
          responses: { '201': { description: 'Webhook created — `secret` is the plaintext value, shown once only' } },
        },
      },
      '/webhooks/{id}': {
        get: {
          tags: ['Webhooks'],
          summary: 'Get a webhook (secret masked as ••••••••)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Webhook object' }, '404': { description: 'Not found' } },
        },
        patch: {
          tags: ['Webhooks'],
          summary: 'Update a webhook',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' } }, collections: { type: 'array', items: { type: 'string' } }, is_active: { type: 'boolean' }, retry_attempts: { type: 'integer' }, timeout: { type: 'integer' }, headers: { type: 'object' } } } } } },
          responses: { '200': { description: 'Updated' }, '404': { description: 'Not found' } },
        },
        delete: {
          tags: ['Webhooks'],
          summary: 'Delete a webhook',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Deleted' }, '404': { description: 'Not found' } },
        },
      },
      '/webhooks/{id}/rotate-secret': {
        post: {
          tags: ['Webhooks'],
          summary: 'Rotate signing secret — new plaintext returned once',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'New secret', content: { 'application/json': { schema: { type: 'object', properties: { secret: { type: 'string' }, webhook: { type: 'object' } } } } } } },
        },
      },
      '/webhooks/{id}/test': {
        post: {
          tags: ['Webhooks'],
          summary: 'Send a synthetic test event to verify the endpoint is reachable',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Test payload sent' } },
        },
      },
      '/webhooks/{id}/deliveries': {
        get: {
          tags: ['Webhooks'],
          summary: 'List delivery history',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          ],
          responses: { '200': { description: 'Deliveries list' } },
        },
      },
      '/webhooks/{id}/deliveries/{deliveryId}/retry': {
        post: {
          tags: ['Webhooks'],
          summary: 'Force re-delivery of a specific attempt regardless of retry count',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'deliveryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': { description: 'Re-delivered' } },
        },
      },

      // ── API Keys ───────────────────────────────────────────────────────────
      '/api-keys': {
        get: {
          tags: ['API Keys'],
          summary: 'List API keys for the current user (hashes only — plaintext not stored)',
          responses: { '200': { description: 'API keys list' } },
        },
        post: {
          tags: ['API Keys'],
          summary: 'Create an API key — raw zvk_ key returned once',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' }, description: 'e.g. ["products:read", "orders:create"]' }, expires_at: { type: 'string', format: 'date-time', nullable: true } } } } },
          },
          responses: { '201': { description: 'API key created — `key` field contains the `zvk_...` plaintext, shown once only' } },
        },
      },
      '/api-keys/{id}': {
        delete: {
          tags: ['API Keys'],
          summary: 'Revoke an API key immediately',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Key revoked' }, '404': { description: 'Not found' } },
        },
      },
      '/api-keys/{id}/rate-limit': {
        put: {
          tags: ['API Keys'],
          summary: 'Set a per-key rate limit override (takes precedence over tier defaults)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['window_ms', 'max_requests'], properties: { window_ms: { type: 'integer', example: 60000, description: 'Window size in ms' }, max_requests: { type: 'integer', example: 1000, description: 'Max requests allowed in the window' } } } } } },
          responses: { '200': { description: 'Rate limit applied' } },
        },
        delete: {
          tags: ['API Keys'],
          summary: 'Remove per-key rate limit override (reverts to tier default)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Override removed' } },
        },
      },

      // ── Realtime ───────────────────────────────────────────────────────────
      '/realtime/stream': {
        get: {
          tags: ['Realtime'],
          summary: 'SSE stream — data changes, presence events, broadcast messages',
          parameters: [
            { name: 'collections', in: 'query', schema: { type: 'string' }, description: 'Comma-separated collection names to watch' },
            { name: 'channel', in: 'query', schema: { type: 'string' }, description: 'Extra channels: broadcast:name, presence:name' },
          ],
          responses: { '200': { description: 'text/event-stream — event types: `data`, `presence`, `broadcast`', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
        },
      },
      '/realtime/presence/{channel}': {
        post: {
          tags: ['Realtime'],
          summary: 'Join a presence channel (re-call every ≤30s to stay active)',
          parameters: [{ name: 'channel', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true, description: 'Optional user metadata (display name, avatar, etc.)' } } } },
          responses: { '200': { description: 'Joined — returns current member list' } },
        },
        get: {
          tags: ['Realtime'],
          summary: 'List presence channel members',
          parameters: [{ name: 'channel', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Members list', content: { 'application/json': { schema: { type: 'object', properties: { channel: { type: 'string' }, members: { type: 'array', items: { type: 'object', properties: { userId: { type: 'string' }, lastSeen: { type: 'integer' } } } } } } } } } },
        },
        delete: {
          tags: ['Realtime'],
          summary: 'Leave a presence channel',
          parameters: [{ name: 'channel', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Left' } },
        },
      },
      '/realtime/broadcast/{channel}': {
        post: {
          tags: ['Realtime'],
          summary: 'Broadcast a message to all SSE subscribers on a channel',
          parameters: [{ name: 'channel', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
          responses: { '200': { description: 'Message delivered to all active subscribers' } },
        },
      },

      // ── Admin ──────────────────────────────────────────────────────────────
      '/admin/rate-limits': {
        get: {
          tags: ['Admin'],
          summary: 'List all rate limit tier configs',
          responses: { '200': { description: 'Rate limit configs per tier (auth/api/ai/write/ddl/destructive)' } },
        },
      },
      '/admin/rate-limits/{keyPrefix}': {
        patch: {
          tags: ['Admin'],
          summary: 'Update a rate limit tier at runtime — no restart needed',
          parameters: [{ name: 'keyPrefix', in: 'path', required: true, schema: { type: 'string', enum: ['auth', 'api', 'ai', 'write', 'ddl', 'destructive'] } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { window_ms: { type: 'integer' }, max_requests: { type: 'integer' } } } } } },
          responses: { '200': { description: 'Updated — takes effect within 60 seconds (config cache TTL)' } },
        },
      },
      '/admin/rate-limits/reset': {
        post: {
          tags: ['Admin'],
          summary: 'Reset all rate limit tiers to built-in defaults',
          responses: { '200': { description: 'Reset to defaults' } },
        },
      },
      '/admin/column-permissions': {
        get: {
          tags: ['Admin'],
          summary: 'List column-level permission rules',
          parameters: [{ name: 'collection', in: 'query', schema: { type: 'string' }, description: 'Filter by collection name' }],
          responses: { '200': { description: 'Column permission rules' } },
        },
        post: {
          tags: ['Admin'],
          summary: 'Create or upsert a column permission rule',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['collection_name', 'column_name', 'role'], properties: { collection_name: { type: 'string' }, column_name: { type: 'string', description: 'Column name or `*` for all columns' }, role: { type: 'string', description: 'Role name or `*` to match all roles. Admins always bypass.' }, can_read: { type: 'boolean', default: true }, can_write: { type: 'boolean', default: true } } } } },
          },
          responses: { '201': { description: 'Rule created or updated' } },
        },
      },
      '/admin/column-permissions/{id}': {
        put: {
          tags: ['Admin'],
          summary: 'Update a column permission rule',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { can_read: { type: 'boolean' }, can_write: { type: 'boolean' } } } } } },
          responses: { '200': { description: 'Updated' }, '404': { description: 'Not found' } },
        },
        delete: {
          tags: ['Admin'],
          summary: 'Delete a column permission rule',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Deleted' }, '404': { description: 'Not found' } },
        },
      },

      // ── Notifications ──────────────────────────────────────────────────────
      '/notifications/push-tokens': {
        post: {
          tags: ['Notifications'],
          summary: 'Register a device push token (FCM/APNS/Web)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['token', 'platform'], properties: { token: { type: 'string', description: 'FCM registration token or APNS device token' }, platform: { type: 'string', enum: ['fcm', 'apns', 'web'] } } } } },
          },
          responses: { '201': { description: 'Token registered' } },
        },
        get: {
          tags: ['Notifications'],
          summary: 'List push tokens for the current user',
          responses: { '200': { description: 'Push tokens list' } },
        },
      },
      '/notifications/push-tokens/{id}': {
        delete: {
          tags: ['Notifications'],
          summary: 'Unregister a push token',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Token removed' }, '404': { description: 'Not found' } },
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
