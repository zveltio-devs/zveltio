import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { toJsonb } from '../lib/jsonb.js';
import { checkPermission, requireInstanceAdmin } from '../lib/tenancy/index.js';

/**
 * Settings whose value is a credential and must never be read back.
 *
 * `GET /api/settings` returned every row verbatim, so `smtp_pass` — the mail
 * account's password — came back in plaintext to anyone who could read
 * settings. Writable and readable are not the same question: an operator has to
 * SET the password, and nothing about that requires the API to hand it back
 * afterwards. It was returned only because the handler had no reason to treat
 * one key differently from another.
 *
 * Matched by suffix rather than by an exact list, so a `*_secret` or `*_token`
 * added later is covered on the day it lands. A list of exact names is a list
 * someone forgets to extend, which is how this one got here.
 */
const SECRET_SETTING_SUFFIXES = ['_pass', '_password', '_secret', '_token', '_api_key', '_key'];

/** Keys that end in a secret-looking suffix but are not secrets. */
const SECRET_SETTING_EXCEPTIONS = new Set(['public_key', 'storage_key_prefix']);

function isSecretSettingKey(key: string): boolean {
  if (SECRET_SETTING_EXCEPTIONS.has(key)) return false;
  return SECRET_SETTING_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/** What a configured secret reads back as. */
const MASKED_SECRET = '********';

/**
 * Report whether a secret is set without disclosing it.
 *
 * The Studio needs to render "configured" vs "not configured", which is the
 * only thing a settings screen legitimately needs. Returning a fixed-length
 * mask rather than one derived from the value keeps the length out of it too.
 */
function maskSecret(raw: unknown): string | null {
  const present =
    raw !== null && raw !== undefined && String(raw).replace(/^"|"$/g, '').trim() !== '';
  return present ? MASKED_SECRET : null;
}

// Security: only these keys can be written via the API.
// Internal/system keys that affect engine security are listed in READONLY_SETTINGS_KEYS.
const WRITABLE_SETTINGS_KEYS = new Set([
  // Branding & UI
  'branding',
  'company_name',
  'site_name',
  'site_url',
  'logo_url',
  'favicon_url',
  'primary_color',
  'support_email',
  'contact_email',
  'timezone',
  'date_format',
  'language',
  // Feature toggles (non-security)
  'maintenance_mode',
  'registration_enabled',
  'api_docs_public',
  'max_upload_size_mb',
  'allowed_file_types',
  'default_collection_permissions',
  // General
  'app_name',
  // Email configuration
  'smtp_host',
  'smtp_port',
  'smtp_from_name',
  'smtp_from_email',
  'smtp_from',
  'smtp_secure',
  'smtp_user',
  'smtp_pass',
  // Security
  'two_factor_enabled',
  'session_expiry_hours',
  'api_rate_limit',
  // AI configuration (non-secret)
  'ai_enabled',
  'ai_default_provider',
  'ai_default_model',
  'ai_max_tokens_per_request',
  // Storage configuration (non-secret)
  's3_public_url',
  's3_bucket_public',
  // Monitoring
  'audit_log_retention_days',
  'session_max_age_days',
  // Rate limiting
  'rate_limiting',
]);

// These keys are system-managed and NEVER writable via the settings API.
const READONLY_SETTINGS_KEYS = new Set([
  'auth_secret',
  'jwt_secret',
  'encryption_key',
  'database_url',
  'redis_url',
  'internal_api_key',
  'webhook_signing_secret',
  'license_key',
  'engine_version',
  'schema_version',
  'marketplace_auth_token',
]);

/**
 * Whether public self-registration is allowed. Default FALSE — Zveltio is
 * app/intranet-first, not open-registration; an operator opts in by setting
 * `registration_enabled` = true. Read at request time so toggling takes effect
 * without a restart. Guards the public HTTP sign-up (routes/index.ts); admin
 * invitations create users in-process (auth.api.signUpEmail) and are unaffected,
 * as is the CLI create-god path.
 */
export async function isRegistrationEnabled(db: Database): Promise<boolean> {
  // Env override wins over the DB setting — lets an operator force self-signup
  // on/off without DB access (12-factor), and lets test/CI enable it uniformly.
  const env = process.env.ZVELTIO_REGISTRATION_ENABLED;
  if (env != null && env !== '') return env === '1' || env.toLowerCase() === 'true';

  const row = await db
    .selectFrom('zv_settings')
    .select('value')
    .where('key', '=', 'registration_enabled')
    .executeTakeFirst()
    // fabricated-ok: falls to `return false` — registration stays CLOSED when the setting cannot be read, which is the refusing direction.
    .catch(() => null);
  if (!row) return false;
  const raw = (row as { value: unknown }).value;
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      v = raw;
    }
  }
  return v === true || v === 'true' || v === 1;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
export function settingsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // GET /public — Public settings (no auth required)
  // Security: double-guard — is_public flag AND explicit whitelist.
  // Even if a sensitive key is accidentally marked is_public, it won't be served.
  const PUBLIC_SETTINGS_WHITELIST = new Set([
    'branding',
    'company_name',
    'site_name',
    'site_url',
    'logo_url',
    'favicon_url',
    'primary_color',
    'language',
    'timezone',
    'date_format',
    'support_email',
    'contact_email',
    'registration_enabled',
    'api_docs_public',
    'maintenance_mode',
    'ai_enabled',
    'ai_default_model',
  ]);

  app.get('/public', async (c) => {
    const settings = await db
      .selectFrom('zv_settings')
      .selectAll()
      .where('is_public', '=', true)
      .execute();

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const result: Record<string, any> = {};
    for (const s of settings) {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const key = (s as any).key as string;
      if (!PUBLIC_SETTINGS_WHITELIST.has(key)) continue; // extra guard
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const raw = (s as any).value;
      if (typeof raw === 'string') {
        try {
          result[key] = JSON.parse(raw);
        } catch {
          result[key] = raw;
        }
      } else {
        result[key] = raw;
      }
    }
    // Always report registration_enabled with its true default (false), even
    // when it isn't a stored is_public row, so the login UI shows/hides the
    // "Create Account" action correctly and never disagrees with the server gate.
    result.registration_enabled = await isRegistrationEnabled(db);
    return c.json(result);
  });

  // All other settings require admin
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await requireInstanceAdmin(session.user.id))) {
      return c.json({ error: 'Admin access required' }, 403);
    }
    await next();
  });

  // GET / — All settings
  app.get('/', async (c) => {
    const settings = await db.selectFrom('zv_settings').selectAll().orderBy('key').execute();

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const result: Record<string, any> = {};
    for (const s of settings) {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const key = (s as any).key as string;
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const raw = (s as any).value;

      if (isSecretSettingKey(key)) {
        result[key] = maskSecret(raw);
        continue;
      }

      if (typeof raw === 'string') {
        try {
          result[key] = JSON.parse(raw);
        } catch {
          result[key] = raw;
        }
      } else {
        result[key] = raw;
      }
    }
    return c.json(result);
  });

  // GET /:key — Get a single setting
  app.get('/:key', async (c) => {
    const setting = await db
      .selectFrom('zv_settings')
      .selectAll()
      .where('key', '=', c.req.param('key'))
      .executeTakeFirst();

    if (!setting) return c.json({ error: 'Setting not found' }, 404);

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const raw = (setting as any).value;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    let parsed: any;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    } else {
      parsed = raw;
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    return c.json({ key: (setting as any).key, value: parsed });
  });

  // PUT /:key — Upsert a setting
  app.put(
    '/:key',
    zValidator('json', z.object({ value: z.any(), is_public: z.boolean().optional() })),
    async (c) => {
      const key = c.req.param('key');
      if (READONLY_SETTINGS_KEYS.has(key)) {
        return c.json(
          { error: `Setting key "${key}" is read-only and cannot be modified via the API.` },
          403,
        );
      }
      if (!WRITABLE_SETTINGS_KEYS.has(key)) {
        return c.json({ error: `Setting key "${key}" is not a recognized writable setting.` }, 400);
      }
      const { value, is_public } = c.req.valid('json');
      // Never write the mask back over the credential it stands for. A client
      // that reads settings and submits them again — the ordinary shape of a
      // settings form — would otherwise replace the password with `********`
      // and break mail silently. The cost is that this literal cannot be used
      // as a password, which is a better trade than a credential destroyed by
      // an unrelated edit.
      if (isSecretSettingKey(key) && value === MASKED_SECRET) {
        return c.json({ success: true, key, unchanged: true });
      }
      // JSON.stringify throws on circular references — return 400 with a
      // clear message instead of letting it become a generic 500. The result is
      // discarded: it exists to reject the value, not to be written.
      try {
        JSON.stringify(value);
      } catch {
        return c.json({ error: 'Value is not JSON-serializable' }, 400);
      }
      // `toJsonb`, not the serialized string. Bound as a plain string this
      // column stored the JSON TEXT rather than the JSON value — a bulk update
      // of `language: 'en'` landed as `"\"en\""`, one wrapping too many, while
      // the rows written at bootstrap were correct. See lib/jsonb.ts.
      const serialized = toJsonb(value);

      await db
        .insertInto('zv_settings')
        .values({
          key,
          value: serialized,
          is_public: is_public ?? false,
          updated_at: new Date(),
        })
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
        .onConflict((oc: any) =>
          oc.column('key').doUpdateSet({
            value: serialized,
            ...(is_public !== undefined ? { is_public } : {}),
            updated_at: new Date(),
          }),
        )
        .execute();

      return c.json({ success: true, key, value });
    },
  );

  // PATCH /bulk — Update multiple settings at once
  app.patch('/bulk', async (c) => {
    const body = await c.req.json();
    // Security: validate all keys before writing any of them.
    for (const key of Object.keys(body)) {
      if (READONLY_SETTINGS_KEYS.has(key)) {
        return c.json(
          { error: `Setting key "${key}" is read-only and cannot be modified via the API.` },
          403,
        );
      }
      if (!WRITABLE_SETTINGS_KEYS.has(key)) {
        return c.json({ error: `Setting key "${key}" is not a recognized writable setting.` }, 400);
      }
    }
    for (const [key, value] of Object.entries(body)) {
      // A secret read back as `********` and written straight through would
      // overwrite the real credential with the mask. The Studio's settings page
      // loads every value and submits the form, so this is the ordinary path,
      // not an edge case: without it, masking `smtp_pass` would break mail the
      // first time an operator edited an unrelated field.
      //
      // An operator who genuinely wants that literal as a password is asking
      // for something indistinguishable from the accident, so it is refused on
      // both write paths rather than left as a trap on one.
      if (isSecretSettingKey(key) && value === MASKED_SECRET) continue;

      try {
        JSON.stringify(value);
      } catch {
        return c.json({ error: `Value for key "${key}" is not JSON-serializable` }, 400);
      }
      const serialized = toJsonb(value);
      await db
        .insertInto('zv_settings')
        .values({ key, value: serialized, updated_at: new Date() })
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
        .onConflict((oc: any) =>
          oc.column('key').doUpdateSet({ value: serialized, updated_at: new Date() }),
        )
        .execute();
    }
    return c.json({ success: true, updated: Object.keys(body) });
  });

  return app;
}
