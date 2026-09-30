/**
 * A generated identifier Postgres keeps as written.
 *
 * Postgres truncates identifiers to 63 bytes with only a NOTICE, so two long
 * generated names sharing their first 63 characters are the same name. Every
 * index on a collection is `idx_<table>_<suffix>`: past a 50-odd-character
 * collection name they all truncated to one, and each `CREATE INDEX IF NOT
 * EXISTS` after the first saw it "exist" and built nothing — a collection with
 * a 55-character name had 2 of its 9 indexes. Two m2m junction tables did the
 * same and shared one table.
 *
 * A name that fits is returned unchanged, so existing indexes keep theirs. One
 * that does not keeps a readable prefix and ends in a hash of the full name.
 */
export function pgIdentifier(name: string): string {
  if (name.length <= 63) return name;
  return `${name.slice(0, 54)}_${Bun.hash(name).toString(36).slice(0, 8)}`;
}

/** `idx_<table>_<suffix>`, kept unique past the 63-byte limit. */
export function indexName(table: string, suffix: string): string {
  return pgIdentifier(`idx_${table}_${suffix}`);
}
