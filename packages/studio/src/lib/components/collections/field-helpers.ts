// Pure display helpers shared by the collections page and its extracted
// components (RecordDrawer, CollectionDataTable, …). Extracted from
// collections/[name]/+page.svelte (H-07 studio split).

/** Convert "snake_case" into "Snake Case" — a fallback label when a field has
 * no explicit `label`. */
export function humanize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// biome-ignore lint/suspicious/noExplicitAny: field shape is dynamic (collection schema)
export function fieldLabel(f: any): string {
  if (f.label) return f.label;
  return humanize(f.name);
}

// biome-ignore lint/suspicious/noExplicitAny: record shape is dynamic
export function labelFromRecord(record: any): string {
  for (const k of ['name', 'title', 'label', 'email', 'slug', 'full_name', 'display_name']) {
    if (record[k]) return String(record[k]);
  }
  const kv = Object.entries(record).find(
    ([k, v]) => k !== 'id' && !k.startsWith('created') && !k.startsWith('updated') && v != null,
  );
  return kv ? String(kv[1]) : (record.id?.slice(0, 8) ?? '—');
}

export function fmtCell(value: unknown, _type?: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return `${JSON.stringify(value).slice(0, 50)}…`;
  const s = String(value);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

export function fieldBadgeColor(type: string): string {
  const m: Record<string, string> = {
    text: '',
    textarea: '',
    richtext: '',
    number: 'badge-info',
    integer: 'badge-info',
    decimal: 'badge-info',
    boolean: 'badge-success',
    date: 'badge-warning',
    datetime: 'badge-warning',
    timestamp: 'badge-warning',
    m2o: 'badge-secondary',
    reference: 'badge-secondary',
    uuid: 'badge-neutral',
    json: 'badge-neutral',
    jsonb: 'badge-neutral',
  };
  return m[type] ?? '';
}
