/**
 * The configuration an extension is allowed to see.
 *
 * Extensions used to read `process.env` directly. For an in-process extension
 * that means the ENGINE's entire environment — `DATABASE_URL`,
 * `BETTER_AUTH_SECRET`, `FIELD_ENCRYPTION_KEY` — which is both far more than
 * any of them needed and a way around the capability gate on `ctx.internals`:
 * an extension wanting to decrypt without declaring `secrets` could just read
 * the key and do it itself.
 *
 * It was also a correctness bug, not only a security one. Storage settings have
 * an admin-editable DB overlay on top of env (`storageConfig()`), so an
 * administrator who configures object storage from the Studio never reached the
 * extensions reading `S3_*` from the environment: they saw an unset endpoint and
 * silently skipped object storage, exactly the "degrade gracefully" path they
 * were written to take when storage is absent.
 *
 * So this module resolves configuration ONCE, on the host side, from the same
 * source the engine itself uses, and hands extensions a narrow view of it.
 *
 * Values are exposed through getters rather than copied: the storage overlay
 * changes at runtime when an admin saves settings, and a snapshot taken at load
 * would pin whatever was true at boot.
 */

import type { ExtensionConfig, ObjectStorageConfig } from '@zveltio/sdk/extension';
import { storageConfig } from '../storage/index.js';
import { knownExtensionNames } from './worker-sql-policy.js';

function flag(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true';
}

/**
 * Build the config view for one extension.
 *
 * `objectStorage` is present only when the extension is first-party, the
 * manifest declares the `storage` capability, AND the instance actually has
 * object storage configured. It carries the INSTANCE's S3 keys — the whole
 * bucket, past the engine's storage rules — so the capability alone is not
 * enough: `firstParty` is the verified publisher tier (an extension that runs
 * inline passed `enforcePublisherTier`), never the name, which anyone can
 * publish under. Any other extension reads `undefined`, as on an instance
 * without S3, and degrades. Interim until storage/cloud moves onto an engine
 * file API and the capability is retired (v2-candidates entry 5).
 */
/**
 * The slice of the environment that belongs to one extension.
 *
 * An extension reading `process.env` itself sees the ENGINE's entire
 * environment — `DATABASE_URL`, `BETTER_AUTH_SECRET`, `FIELD_ENCRYPTION_KEY` —
 * which is both far more than it needs and a way around the capability gate on
 * `ctx.internals`: an extension wanting to decrypt without declaring `secrets`
 * could take the key and do it itself.
 *
 * The answer is not to move each extension's settings onto `ExtensionConfig`.
 * Deployment configuration for `billing` is Stripe's webhook secret and for
 * `search` it is a Meilisearch URL, and putting either on this interface would
 * put Stripe and Meilisearch into the engine — the engine would then have to
 * know every extension that will ever exist.
 *
 * So the rule is generic and the names stay in the extension: everything under
 * `ZVELTIO_EXT_<NAME>_` is handed to `<NAME>` with the prefix stripped, and
 * nothing else is handed to it at all. `finance/banking` reads
 * `ZVELTIO_EXT_FINANCE_BANKING_*`; `ai` reads `ZVELTIO_EXT_AI_*`. Operators keep
 * configuring through the environment, which is where a self-hosted deployment
 * expects to configure things, and the engine learns nothing about what any
 * particular extension wants.
 *
 * The prefix is not delimited and the fold is not injective, so one key can
 * spell two extensions' settings: `ZVELTIO_EXT_BILLING_STRIPE_WEBHOOK_SECRET` is
 * `billing`'s `STRIPE_WEBHOOK_SECRET` and `billing-stripe`'s `WEBHOOK_SECRET`,
 * and `a-b` and `a_b` share every key. Which one the operator meant is not
 * knowable, and "longest prefix wins" (the table rule, `ownsByPrefix`) would
 * hand `billing`'s secret to whoever publishes `billing-stripe`. So a key that
 * also lies under another known extension's prefix, or under the engine's own
 * `ZVELTIO_EXT_*` settings, is handed to neither, and the operator is told.
 *
 * Withholding depends on which extensions the process knows, and this is a
 * snapshot taken at load: an extension loaded before an overlapping one is
 * installed keeps the newcomer's keys until it reloads. So there is a
 * delimited form (ADR 0030), `ZVELTIO_EXT_<NAME>__<KEY>`: the LAST `__` ends
 * the name, the key has none, and a fold names one installed extension
 * (#1600), so the variable belongs to exactly one extension whatever else is
 * installed. A variable with `__` after `ZVELTIO_EXT_` is read only that way,
 * never as a legacy key under a shorter prefix. The legacy form stays (v1 is
 * frozen); each legacy key is logged with its delimited spelling, and the
 * delimited value wins when both set one key.
 *
 * Read at build time, not per access: `register()` runs once per load, and a
 * frozen snapshot means an extension cannot be handed a value that changed
 * underneath it mid-request.
 */
function namespacedEnv(extName: string | undefined): Readonly<Record<string, string>> {
  if (!extName) return Object.freeze({});
  const name = envName(extName);
  const prefix = `${ENV_ROOT}${name}_`;
  const others = [...knownExtensionNames().filter((n) => n !== extName), ...ENGINE_NAMESPACES].map(
    (n) => `${ENV_ROOT}${envName(n)}_`,
  );
  const legacy: Record<string, string> = {};
  const delimited: Record<string, string> = {};
  const withheld: string[] = [];
  const moved: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string' || !key.startsWith(ENV_ROOT)) continue;
    const rest = key.slice(ENV_ROOT.length);
    const cut = rest.lastIndexOf('__');
    if (cut !== -1) {
      if (rest.slice(0, cut) === name && cut + 2 < rest.length)
        delimited[rest.slice(cut + 2)] = value;
      continue;
    }
    if (!key.startsWith(prefix)) continue;
    if (others.some((p) => key.startsWith(p))) {
      withheld.push(key);
      continue;
    }
    const k = key.slice(prefix.length);
    legacy[k] = value;
    moved.push(`${key} -> ${ENV_ROOT}${name}__${k}`);
  }
  if (withheld.length > 0) {
    console.warn(
      `[extensions] "${extName}": ${withheld.join(', ')} also name another extension's ` +
        `or the engine's settings; withheld from "${extName}"`,
    );
  }
  if (moved.length > 0) {
    console.warn(
      `[extensions] "${extName}": legacy settings, read for now; rename them (ADR 0030): ` +
        moved.join(', '),
    );
  }
  return Object.freeze({ ...legacy, ...delimited });
}

const ENV_ROOT = 'ZVELTIO_EXT_';

/** The name folded as the table prefix folds it, upper-cased. */
function envName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '_').toUpperCase();
}

/**
 * The engine's own `ZVELTIO_EXT_*` settings, as namespaces no extension reads:
 * `RUNNER_SOCKET` and `RUNNER_UID_BASE` (ext-runner.ts), and `MEMORY_MB`
 * (rfc-extension-runner.md).
 */
const ENGINE_NAMESPACES = ['runner', 'memory'];

export function buildExtensionConfig(
  capabilities: readonly string[],
  extName?: string,
  firstParty = false,
): ExtensionConfig {
  const mayReadStorage = firstParty && capabilities.includes('storage');
  const vars = namespacedEnv(extName);

  return Object.freeze({
    vars,
    get env(): 'production' | 'development' | 'test' {
      const v = process.env.NODE_ENV;
      return v === 'production' || v === 'test' ? v : 'development';
    },
    get isProduction(): boolean {
      return process.env.NODE_ENV === 'production';
    },
    get publicUrl(): string | undefined {
      return process.env.PUBLIC_URL?.trim() || undefined;
    },
    /**
     * Whether the instance has a field-encryption key. Deliberately a boolean:
     * extensions need to report/branch on "is encryption configured", never to
     * hold the key — encrypting is `ctx.internals.encryptSecret`, gated by the
     * `secrets` capability.
     */
    get encryptionConfigured(): boolean {
      return Boolean(process.env.FIELD_ENCRYPTION_KEY);
    },
    get crossDomainAuth(): boolean {
      return flag('CROSS_DOMAIN_AUTH');
    },
    /**
     * Permits plaintext LDAP binds. Extension-specific and only meaningful to
     * auth/ldap; it lives here because it is an operator/deployment decision
     * expressed in the environment, not a per-tenant setting. New
     * extension-specific switches belong in extension settings, not here.
     */
    get allowInsecureLdap(): boolean {
      return flag('ALLOW_INSECURE_LDAP');
    },
    get objectStorage(): ObjectStorageConfig | undefined {
      if (!mayReadStorage) return undefined;
      const { driver, s3 } = storageConfig();
      if (driver !== 's3' || !s3.endpoint) return undefined;
      return Object.freeze({
        endpoint: s3.endpoint.replace(/\/$/, ''),
        region: s3.region,
        bucket: s3.bucket,
        publicUrl: s3.publicUrl || undefined,
        accessKeyId: s3.accessKey,
        secretAccessKey: s3.secretKey,
      });
    },
  });
}
