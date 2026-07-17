/**
 * Tenant-aware display formatting (TECHNICAL-GAPS 6.3).
 *
 * `language`, `timezone` and `date_format` have long been writable settings —
 * but nothing read them and there was no UI to set them, so every screen fell
 * back to the *browser's* locale/timezone via bare `toLocaleDateString()`. A
 * Romanian tenant on a US-locale laptop saw US dates. This centralises it: one
 * place reads the tenant's settings, everything formats through it.
 *
 * Settings load once (public endpoint, no auth needed) and are reactive — screens
 * that render before the fetch resolves show browser-default formatting and then
 * re-render with the tenant's once it lands.
 */
import { settingsApi } from '$lib/api.js';

type FormatSettings = {
  language?: string; // BCP-47, e.g. "ro" / "de-AT"
  timezone?: string; // IANA, e.g. "Europe/Bucharest"
  date_format?: string; // 'iso' | 'eu' | 'us' | undefined (= locale default)
};

const s = $state<FormatSettings>({});
let loading: Promise<void> | null = null;

/** Load the tenant's formatting settings. Idempotent; safe to call from any layout. */
export function initFormat(): Promise<void> {
  if (loading) return loading;
  loading = settingsApi
    .getPublic()
    .then((data: Record<string, unknown>) => {
      s.language = typeof data?.language === 'string' ? data.language : undefined;
      s.timezone = typeof data?.timezone === 'string' ? data.timezone : undefined;
      s.date_format = typeof data?.date_format === 'string' ? data.date_format : undefined;
    })
    .catch(() => {
      /* keep browser defaults — formatting must never break a screen */
    });
  return loading;
}

/** Current settings (reactive) — exposed for the settings screen / debugging. */
export function formatSettings(): Readonly<FormatSettings> {
  return s;
}

function locale(): string | undefined {
  return s.language || undefined;
}

function dateOpts(): Intl.DateTimeFormatOptions {
  const tz = s.timezone ? { timeZone: s.timezone } : {};
  switch (s.date_format) {
    case 'iso':
      return { year: 'numeric', month: '2-digit', day: '2-digit', ...tz };
    case 'eu':
      return { day: '2-digit', month: '2-digit', year: 'numeric', ...tz };
    case 'us':
      return { month: '2-digit', day: '2-digit', year: 'numeric', ...tz };
    default:
      return tz; // locale default
  }
}

function toDate(v: unknown): Date | null {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date only, in the tenant's format + timezone. Empty string for unparseable input. */
export function fmtDate(v: unknown): string {
  const d = toDate(v);
  if (!d) return '';
  // 'iso' is a fixed machine format, not a locale one — render it literally.
  if (s.date_format === 'iso') {
    const parts = new Intl.DateTimeFormat('en-CA', dateOpts()).format(d); // en-CA → YYYY-MM-DD
    return parts;
  }
  return d.toLocaleDateString(locale(), dateOpts());
}

/** Date + time, in the tenant's format + timezone. */
export function fmtDateTime(v: unknown): string {
  const d = toDate(v);
  if (!d) return '';
  return d.toLocaleString(locale(), {
    ...dateOpts(),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Time only, in the tenant's timezone. */
export function fmtTime(v: unknown): string {
  const d = toDate(v);
  if (!d) return '';
  return d.toLocaleTimeString(locale(), {
    hour: '2-digit',
    minute: '2-digit',
    ...(s.timezone ? { timeZone: s.timezone } : {}),
  });
}

/** Number in the tenant's locale (thousands separators etc.). */
export function fmtNumber(n: unknown): string {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v.toLocaleString(locale()) : '';
}
