// Extension license-key + license-audit helpers.
//
// Extracted from extension-loader.ts (loader split). Per-extension license keys
// are stored in zv_settings as `ext_license:<name>`; license-modifying handlers
// share one audit shape. These are pure helpers — everything they touch (db, the
// Hono context) is passed in — so they carry no loader state.

/** Per-extension license key from zv_settings (`ext_license:<name>`). Free
 * extensions need no key; paid ones send it as `Authorization: Bearer`. */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export async function getLicenseKey(db: any, extensionName: string): Promise<string | undefined> {
  try {
    const row = await db
      .selectFrom('zv_settings')
      .select('value')
      .where('key', '=', `ext_license:${extensionName}`)
      .executeTakeFirst();
    return row?.value ?? undefined;
  } catch {
    return undefined;
  }
}

// ── License audit helpers (S3-04) ─────────────────────────────────────────────
// Centralized so all license-modifying handlers share the same audit shape.
// Errors are swallowed: an audit-write failure must NEVER block the actual
// rotation/delete. We log to console so ops can still detect missing rows.

export interface LicenseAuditRow {
  action: 'rotate' | 'set' | 'delete';
  extension_name: string | null;
  performed_by: string | null;
  ip: string | null;
  user_agent: string | null;
  details?: Record<string, unknown>;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export async function writeLicenseAudit(db: any, row: LicenseAuditRow): Promise<void> {
  try {
    await db
      .insertInto('zv_license_audit')
      .values({
        action: row.action,
        extension_name: row.extension_name,
        performed_by: row.performed_by,
        ip: row.ip,
        user_agent: row.user_agent,
        details: JSON.stringify(row.details ?? {}),
      })
      .execute();
  } catch (err) {
    console.warn('[license-audit] failed to write audit row:', (err as Error).message);
  }
}

/** SHA-256 hex of the first 16 bytes of the token — enough to correlate
 * rotations in audit logs without storing reversible material. */
export async function fingerprintToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const view = new Uint8Array(buf).slice(0, 8);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
  return out;
}

/** Extract caller IP. Hono honors x-forwarded-for behind trusted proxies. */
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export function clientIp(c: any): string | null {
  const xff = c.req.header('x-forwarded-for') as string | undefined;
  if (xff) return xff.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? null;
}
