/**
 * A theme is data (ADR 0007): a few daisyUI 5 tokens, stored per instance
 * (`zv_settings.theme`) or per tenant (`zv_tenants.settings.theme`) and applied
 * as CSS variables by `@zveltio/ui/theme` when a page loads.
 *
 * Every value lands in a style attribute of a page anyone can open, so each one
 * is a colour, a length or a name from a fixed list — never free text. A value
 * that could close its declaration (`red;background:url(…)`) is refused here,
 * at write, and dropped again by the kit at render.
 */

import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/index.js';

export const THEME_COLORS = [
  'primary',
  'primary-content',
  'secondary',
  'secondary-content',
  'accent',
  'accent-content',
  'neutral',
  'neutral-content',
  'base-100',
  'base-200',
  'base-300',
  'base-content',
  'info',
  'info-content',
  'success',
  'success-content',
  'warning',
  'warning-content',
  'error',
  'error-content',
] as const;

// Same patterns as `packages/ui/src/theme.ts`, which re-checks at render.
const COLOR =
  /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|oklch\(\d{1,3}(\.\d{1,4})?%? \d(\.\d{1,4})? \d{1,3}(\.\d{1,4})?\))$/i;
const LENGTH = /^(0|\d{1,2}(\.\d{1,4})?(rem|px))$/;

const color = z.string().regex(COLOR);
const length = z.string().regex(LENGTH);

export const themeSchema = z
  .object({
    scheme: z.enum(['light', 'dark']).optional(),
    colors: z
      .object(Object.fromEntries(THEME_COLORS.map((k) => [k, color.optional()])))
      .strict()
      .optional(),
    radius: z
      .object({ selector: length.optional(), field: length.optional(), box: length.optional() })
      .strict()
      .optional(),
    border: length.optional(),
    font: z.enum(['system', 'sans', 'serif', 'mono']).optional(),
    density: z.enum(['compact', 'normal', 'comfortable']).optional(),
  })
  .strict();

export type Theme = z.infer<typeof themeSchema>;

/** A stored theme, or null when absent or no longer valid. */
export function parseTheme(raw: unknown): Theme | null {
  let value = raw;
  // Bun.SQL may hand jsonb back as its text (see lib/jsonb.ts).
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = themeSchema.safeParse(value);
  return value != null && parsed.success ? parsed.data : null;
}

/** The tenant's theme where it set one, else the instance's; null when neither is valid. */
export async function effectiveTheme(db: Database, tenantId: string | null): Promise<Theme | null> {
  const r = await sql<{ tenant: unknown; instance: unknown }>`
    SELECT
      (SELECT settings->'theme' FROM zv_tenants WHERE id = ${tenantId}::uuid) AS tenant,
      (SELECT value FROM zv_settings WHERE key = 'theme') AS instance
  `.execute(db);
  return parseTheme(r.rows[0]?.tenant) ?? parseTheme(r.rows[0]?.instance);
}
