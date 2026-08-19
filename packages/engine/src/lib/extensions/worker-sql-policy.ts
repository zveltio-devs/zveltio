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

/**
 * Statement forms whose payload is *code* rather than data.
 *
 * The identifier scan below blanks dollar-quoted blocks, because a dollar quote
 * is normally just a string constant and a table name mentioned inside one is
 * data, not a reference (see the `$tag$ … $tag$` case in the tests). That is
 * safe right up until the body is handed to a executor, and then it inverts:
 *
 *     DO $$ BEGIN EXECUTE 'SELECT secret FROM zv_api_keys'; END $$
 *
 * survives the scan with nothing left to look at, and Postgres runs the body as
 * the database owner. The multi-statement defence does not apply either — `DO`
 * is one statement, so the extended-query protocol is happy to send it.
 *
 * Tightening the scan cannot fix this: a body can build its SQL by
 * concatenation (`'zv_' || 'api_keys'`), which no amount of text matching will
 * see. The only durable answer is to refuse the forms that turn a string into
 * executable SQL. None of them belong on a runtime query bridge anyway —
 * extensions declare their schema through migrations, not through ad-hoc DDL.
 */
const CODE_BEARING_FORMS: { re: RegExp; what: string }[] = [
  // `DO` only ever introduces an anonymous code block. Anchored to the start of
  // the statement so `ON CONFLICT DO NOTHING` and `DO UPDATE` stay legal.
  { re: /^\s*DO\b/i, what: 'DO (anonymous code block)' },
  { re: /^\s*CALL\b/i, what: 'CALL (stored procedure)' },
  // Server-side prepared statements outlive the statement that made them, and
  // the bridge hands back a pooled connection that another extension will reuse.
  { re: /^\s*(EXECUTE|PREPARE|DEALLOCATE)\b/i, what: 'PREPARE/EXECUTE' },
  {
    re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i,
    what: 'CREATE FUNCTION/PROCEDURE',
  },
  // `COPY … FROM PROGRAM` is command execution on the database host, not SQL.
  { re: /\bCOPY\b[\s\S]*?\bPROGRAM\b/i, what: 'COPY … PROGRAM' },
];

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

  // Checked on the stripped text so the keyword has to be real code — a
  // `SELECT 'call me'` must not trip the CALL rule.
  for (const form of CODE_BEARING_FORMS) {
    if (form.re.test(code)) {
      throw new WorkerSqlPolicyError(
        `Extension "${extName}" attempted ${form.what} through the worker SQL ` +
          `bridge. Statements that execute a body as code are refused here: the ` +
          `body is opaque to the table policy and can assemble any table name at ` +
          `runtime. Declare schema and functions in the extension's migrations.`,
      );
    }
  }

  // ── Table references: ALLOWLIST ───────────────────────────────────────────
  //
  // This matched `zv_*` and nothing else, which made it a denylist over an open
  // namespace: it had no rule at all for UNPREFIXED tables, and that is exactly
  // where Better-Auth keeps `user`, `session`, `account`, `verification` and
  // `twoFactor`. None of them has RLS, and the worker role holds DML on every
  // table in `public`, so `SELECT token FROM "session"` and
  // `UPDATE "user" SET role = 'admin'` were both accepted — by the sandbox whose
  // entire purpose is to contain code the platform has decided not to trust.
  //
  // A denylist over an open namespace is not a control. Every table anyone adds
  // in future is reachable until someone remembers to name it. So the rule is
  // inverted: a table reference is refused unless it is a user-data collection
  // (`zvd_*`) or this extension's own namespace. Anything unrecognised —
  // `user`, `pg_catalog.pg_authid`, a table added next year — is refused
  // because it was never permitted, not because it was listed.
  const cteNames = collectCteNames(code);
  const offenders = new Set<string>();

  for (const ref of tableReferences(code)) {
    // A CTE is a name this statement itself defined; it is not a table.
    if (cteNames.has(ref.table)) continue;

    if (ref.schema !== null && ref.schema !== 'public') {
      // `information_schema.tables`, `pg_catalog.pg_authid` — the catalogue
      // discloses every table name, column and role on the instance, which is
      // reconnaissance for whatever comes next.
      offenders.add(`${ref.schema}.${ref.table}`);
      continue;
    }
    if (ref.table.startsWith('zvd_')) continue;
    if (ref.table.startsWith(owned)) continue;
    offenders.add(ref.table);
  }

  if (offenders.size > 0) {
    throw new WorkerSqlPolicyError(
      `Extension "${extName}" attempted to access ${[...offenders].sort().join(', ')} ` +
        `through the worker SQL bridge. Extensions may query user data tables ` +
        `(zvd_*) and their own namespace (${ownedPrefixFor(extName)}*) only — ` +
        `anything else is refused because it was never permitted, which is what ` +
        `makes this an allowlist rather than a list of tables someone remembered.`,
    );
  }
}

/**
 * Names bound by `WITH … AS (…)` in this statement.
 *
 * A CTE is not a table; refusing one would break `WITH recent AS (SELECT …
 * FROM zvd_orders) SELECT * FROM recent`, which is an ordinary query over
 * permitted data. Collected from the code with literals and comments already
 * blanked, so a name mentioned in a string cannot introduce one.
 */
function collectCteNames(code: string): Set<string> {
  const out = new Set<string>();
  // `WITH a AS (`, `WITH RECURSIVE a AS (`, and each `, b AS (` that follows.
  const re = /(?:\bwith\s+(?:recursive\s+)?|,\s*)("?[A-Za-z_][A-Za-z0-9_$]*"?)\s+as\s*\(/gi;
  for (const m of code.matchAll(re)) out.add(unquote(m[1]!));
  return out;
}

interface TableRef {
  /** Lower-cased schema, or null when the reference is unqualified. */
  schema: string | null;
  /** Lower-cased table name. */
  table: string;
}

/**
 * Every identifier appearing in a TABLE position.
 *
 * Keyed off the keywords that introduce one — `FROM`, `JOIN`, `INTO`,
 * `UPDATE`, `DELETE FROM` — rather than by trying to parse SQL. A subquery
 * (`FROM (SELECT …`) does not match, because the next token is a parenthesis
 * and not an identifier; its own inner `FROM` is matched on its own.
 *
 * This does not have to be a complete parser to be a sound allowlist: anything
 * it fails to recognise as a table simply is not granted, and the database role
 * added in migration 043 refuses the statement regardless of what this saw.
 */
function tableReferences(code: string): TableRef[] {
  const IDENT_SRC = '(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)';
  // Where a table list begins.
  const INTRO = /\b(?:from|join|into|update)\b/gi;
  // One entry: `schema.table`, `table`, optionally followed by an alias.
  const ENTRY = new RegExp(`^\\s*(${IDENT_SRC})(?:\\s*\\.\\s*(${IDENT_SRC}))?`, 'i');
  // A word that ends the list. `FROM a, b WHERE …` stops at WHERE; without this
  // the alias-and-comma walk below would run into the rest of the statement.
  const STOP =
    /^\s*(?:where|group|order|having|limit|offset|on|using|union|intersect|except|returning|set|values|window|for|left|right|inner|outer|full|cross|natural|join|select|as)\b/i;

  const out: TableRef[] = [];
  for (const intro of code.matchAll(INTRO)) {
    let rest = code.slice(intro.index! + intro[0].length);

    // Comma-separated lists, which the first version of this missed entirely:
    // it read the identifier after FROM and stopped, so `FROM zvd_orders,
    // "user"` was permitted on the strength of its first entry. The existing
    // suite caught it — the case that failed was the one asserting the error
    // NAMES every offending table, which is the same fact seen from the side.
    for (;;) {
      // A keyword here means this intro did not introduce a table list at all.
      // `ON CONFLICT (id) DO UPDATE SET x = $1` contains the word UPDATE, and
      // reading `SET` as a table name refused an ordinary upsert — a gate that
      // rejects `ON CONFLICT DO UPDATE` is a gate someone turns off.
      if (STOP.test(rest)) break;

      const m = ENTRY.exec(rest);
      if (!m) break;
      // A subquery (`FROM (SELECT …`) has a parenthesis here, not an identifier,
      // so ENTRY does not match and its own FROM is picked up separately.
      const first = unquote(m[1]!);
      const second = m[2] ? unquote(m[2]) : null;
      out.push(second === null ? { schema: null, table: first } : { schema: first, table: second });

      rest = rest.slice(m[0].length);
      // Skip an alias, with or without AS, then look for a comma.
      const alias = /^\s+(?:as\s+)?(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/i.exec(rest);
      if (alias && !STOP.test(rest)) rest = rest.slice(alias[0].length);
      const comma = /^\s*,/.exec(rest);
      if (!comma) break;
      rest = rest.slice(comma[0].length);
    }
  }
  return out;
}

function unquote(ident: string): string {
  return ident.replace(/^"|"$/g, '').toLowerCase();
}
