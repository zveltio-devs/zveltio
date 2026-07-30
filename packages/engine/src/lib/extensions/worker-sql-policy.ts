/**
 * Table policy for the worker→host SQL bridge.
 *
 * Worker-isolated extensions send raw SQL text to the host, which used to run it
 * with `pool.unsafe()` — no table restriction, no timeout, no statement limit.
 * That inverted the trust model: `enforcePublisherTier` requires *community*
 * (untrusted, third-party) extensions to run in a worker precisely because the
 * worker is supposed to be the boundary, yet the bridge gave them strictly MORE
 * reach than an inline extension, which is proxied through createRestrictedDb.
 *
 * This module re-states that proxy's rule for raw SQL: an extension may touch
 * user-data tables (`zvd_*`) and its own namespace (`zv_<ext>_*`), but not the
 * engine's own `zv_*` tables — where the sessions, API keys, tenants and Casbin
 * policies live.
 *
 * Text matching is a weaker instrument than the proxy's structural check, so it
 * is deliberately conservative: anything that looks like a reference to a
 * non-owned `zv_` identifier is refused, whatever the case and whether or not it
 * is schema-qualified or quoted. A false rejection is a bug report; a false
 * acceptance is a breach.
 */

export class WorkerSqlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerSqlPolicyError';
  }
}

/** `zv_` + the extension name with non-alphanumerics folded to `_`, matching createRestrictedDb. */
export function ownedPrefixFor(extName: string): string {
  return `zv_${extName.replace(/[^a-z0-9]/gi, '_')}_`;
}

/**
 * Blank out string literals, dollar-quoted blocks and comments, so identifier
 * matching cannot be fooled by a table name mentioned inside a string, and so a
 * `--` or `/* *\/` comment cannot hide one.
 */
function stripNonCode(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    // Dollar-quoted: $tag$ ... $tag$
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }

    out += sql[i];
    i += 1;
  }
  return out;
}

/**
 * Reject SQL that references an engine system table the extension does not own.
 *
 * Note what is NOT relied on here: the host runs the statement on a *reserved*
 * connection, which Bun drives through the extended-query protocol, so a second
 * statement after a semicolon is rejected by the server rather than by this
 * function. Multi-statement payloads are therefore structurally impossible, and
 * this check only has to reason about the tables one statement can name.
 */
export function assertWorkerSqlAllowed(extName: string, sql: string): void {
  const owned = ownedPrefixFor(extName).toLowerCase();
  const code = stripNonCode(sql);

  // `zv_` followed by anything identifier-ish. `zvd_` never matches: the third
  // character is `d`, not `_`, which is exactly how the inline proxy separates
  // user-data tables from engine tables.
  const IDENT_RE = /(?<![A-Za-z0-9_])"?(zv_[A-Za-z0-9_]+)"?/gi;

  const offenders = new Set<string>();
  for (const m of code.matchAll(IDENT_RE)) {
    const ident = m[1].toLowerCase();
    if (!ident.startsWith(owned)) offenders.add(ident);
  }

  if (offenders.size > 0) {
    throw new WorkerSqlPolicyError(
      `Extension "${extName}" attempted to access engine system table(s) ` +
        `${[...offenders].sort().join(', ')} through the worker SQL bridge. ` +
        `Extensions may query user data tables (zvd_*) and their own namespace ` +
        `(${ownedPrefixFor(extName)}*) only.`,
    );
  }
}
