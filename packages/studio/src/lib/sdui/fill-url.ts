/**
 * A declarative page's endpoint with its `{field}` tokens filled from `value`,
 * each value URI-encoded: a value with `&`, `#`, `?` or `/` is one path segment
 * or query value, not URL syntax. It used to go in raw, so `a&b` split a query
 * parameter and `x/../../api/users` walked out of the extension's namespace.
 */
export function fillUrl(tmpl: string, value: (key: string) => unknown): string {
  return tmpl.replace(/\{([^}]+)\}/g, (_, k: string) =>
    encodeURIComponent(String(value(k.trim()) ?? '')),
  );
}
