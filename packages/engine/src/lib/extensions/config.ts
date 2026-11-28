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
import { isProduction, modeOn, nodeEnv } from '../operational-modes.js';
import { keyList } from '../security/index.js';

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
 * `ZVELTIO_EXT_<NAME>__` is handed to `<NAME>` with the prefix stripped, and
 * nothing else is handed to it at all. `finance/banking` reads
 * `ZVELTIO_EXT_FINANCE_BANKING__*`; `ai` reads `ZVELTIO_EXT_AI__*`. Operators keep
 * configuring through the environment, which is where a self-hosted deployment
 * expects to configure things, and the engine learns nothing about what any
 * particular extension wants.
 *
 * The name ends at the LAST `__` (ADR 0030, extension-api v2 entry 6): an
 * extension reads `ZVELTIO_EXT_<NAME>__<KEY>`, the key has no `__`, and a fold
 * names one installed extension (#1600), so each variable belongs to exactly
 * one extension whatever else is installed. The single-underscore spelling
 * `ZVELTIO_EXT_<NAME>_<KEY>` is no longer read (ADR 0063): it spelled two
 * extensions' settings at once (`billing`'s `STRIPE_KEY` was `billing-stripe`'s
 * `KEY`). The engine's own `ZVELTIO_EXT_*` settings (`TRANSPORT`,
 * `RUNNER_SOCKET`, …) carry no `__`, so no extension reads them. A legacy
 * variable left set is named at load, so the operator learns to rename it.
 *
 * Read at build time, not per access: `register()` runs once per load, and a
 * frozen snapshot means an extension cannot be handed a value that changed
 * underneath it mid-request.
 */
function namespacedEnv(extName: string | undefined): Readonly<Record<string, string>> {
  if (!extName) return Object.freeze({});
  const name = envName(extName);
  const vars: Record<string, string> = {};
  const legacy: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string' || !key.startsWith(ENV_ROOT)) continue;
    const rest = key.slice(ENV_ROOT.length);
    const cut = rest.lastIndexOf('__');
    if (cut !== -1) {
      if (rest.slice(0, cut) === name && cut + 2 < rest.length) vars[rest.slice(cut + 2)] = value;
    } else if (rest.startsWith(`${name}_`)) {
      legacy.push(`${key} -> ${ENV_ROOT}${name}__${rest.slice(name.length + 1)}`);
    }
  }
  if (legacy.length > 0) {
    console.warn(
      `[extensions] "${extName}": not read, the single-underscore spelling was removed ` +
        `(ADR 0063); rename: ${legacy.join(', ')}`,
    );
  }
  return Object.freeze(vars);
}

const ENV_ROOT = 'ZVELTIO_EXT_';

/** The name folded as the table prefix folds it, upper-cased. */
function envName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '_').toUpperCase();
}

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
      if (isProduction()) return 'production';
      return nodeEnv() === 'test' ? 'test' : 'development';
    },
    get isProduction(): boolean {
      return isProduction();
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
      return keyList('field').currentOk;
    },
    get crossDomainAuth(): boolean {
      return flag('CROSS_DOMAIN_AUTH');
    },
    /**
     * Permits plaintext LDAP binds. Extension-specific and only meaningful to
     * auth/ldap; it lives here because it is an operator/deployment decision
     * expressed in the environment, not a per-tenant setting. New
     * extension-specific switches belong in extension settings, not here —
     * unless, like the two below, they switch off a check a tenant admin must
     * not be able to switch off (ADR 0058 d4): those are dated operational modes.
     */
    get allowInsecureLdap(): boolean {
      return modeOn('ALLOW_INSECURE_LDAP');
    },
    /**
     * Skips LDAPS certificate verification (auth/ldap), for every tenant. An
     * environment hatch with a date (ADR 0058 d4): it was the Console field
     * `tls_verify`, which any tenant admin could turn off.
     */
    get allowUnverifiedLdaps(): boolean {
      return modeOn('ZVELTIO_ALLOW_UNVERIFIED_LDAPS');
    },
    /** Skips the SAML audience check (auth/saml), for every tenant. As above: was `audience_check`. */
    get allowSamlAnyAudience(): boolean {
      return modeOn('ZVELTIO_ALLOW_SAML_ANY_AUDIENCE');
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
