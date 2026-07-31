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
import { storageConfig } from '../storage/config.js';

function flag(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true';
}

/**
 * Build the config view for one extension.
 *
 * `objectStorage` is present only when the manifest declares the `storage`
 * capability AND the instance actually has object storage configured. Both
 * conditions matter: the capability makes the credential access visible at
 * review and install time, and the `undefined` tells an extension that storage
 * is absent so it can degrade instead of throwing.
 */
export function buildExtensionConfig(capabilities: readonly string[]): ExtensionConfig {
  const mayReadStorage = capabilities.includes('storage');

  return Object.freeze({
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
