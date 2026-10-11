/**
 * Comments blanked to spaces, newlines and columns kept, so a match's offset
 * in the result still gives its line in the source. Quotes are tracked, so a
 * `//` or `/*` inside a string stays code.
 *
 * One scanner for every gate; seven used to carry their own copy. The two-regex
 * version (block comments first, then line comments) does not know what a
 * string or a line comment is, so any `/*` opens a "block comment" that runs to
 * the next `*\/` in the file, and everything between is never scanned:
 *   - `app.use('/*', …)` deleted 746 of 1641 lines of the mail extension's
 *     routes before `check-atomic-writes` read them (found 2026-09-04);
 *   - `// the /ext/* gate` hid six of twelve sites in one extension file from
 *     the admin-gate ratchet (found 2026-10-11).
 *
 * Blanking, not deleting: every offset downstream, and every line number a gate
 * reports, stays the file's own. And a JSDoc header that quotes the form a gate
 * refuses — this repository's house style — is prose, not a site.
 *
 * Regex literals are not tracked. `/*` cannot begin one in valid JavaScript
 * (`a / *b` does not parse); a quote inside one opens a "string", which ends
 * at the end of the line for `'` and `"` because those cannot span lines.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  // Which quote we are inside, or null in code. `${}` inside a template is
  // treated as more template: a comment cannot hide where a `${` would.
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (quote) {
      if (ch === '\\') {
        out += ch + (next ?? '');
        i += 2;
        continue;
      }
      if (ch === quote || (ch === '\n' && quote !== '`')) quote = null;
      out += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    // Outside a string, a backslash only appears in a regex literal (or an
    // identifier's \u escape), so the pair is copied whole: `/\//g` is
    // `\/` then `/`, not a `//` comment that blanks the rest of the line.
    if (ch === '\\') {
      out += ch + (next ?? '');
      i += 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
