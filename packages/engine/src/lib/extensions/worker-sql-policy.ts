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
 * The statements an extension may send: queries and DML, nothing else.
 *
 * The table allowlist below reads the tables a statement names in a FROM, JOIN,
 * INTO, UPDATE, USING or TABLE position. Everything else Postgres accepts names
 * its target somewhere that scan never looks, or nowhere at all: `TRUNCATE
 * "session"`, `DROP TABLE zv_api_keys`, `ALTER TABLE "user" DISABLE ROW LEVEL
 * SECURITY`, `GRANT … TO PUBLIC`, `COMMENT ON`, `CREATE TRIGGER … ON
 * zv_api_keys`, `SET LOCAL zveltio.rls_bypass = on`, `RESET ALL`, `VACUUM`.
 * Measured on `ctx.db`: every one of them reached Postgres, which ran them as the
 * engine role. A list of forbidden forms is the denylist this file already
 * learned not to trust, so the forms are an allowlist too.
 *
 * Statements whose body is code (`DO`, `CALL`, `CREATE FUNCTION`, `PREPARE` /
 * `EXECUTE`) fall outside it: a body can assemble a table name at runtime
 * (`'zv_' || 'api_keys'`), so no text scan can clear one. So does transaction
 * control: a `COMMIT` ends the bridge's transaction and turns its `SET LOCAL
 * ROLE` and tenant GUC into session settings on a pooled connection. The engine
 * issues BEGIN, COMMIT and SAVEPOINT itself, on its own handle, for
 * `ctx.db.transaction()`. Schema changes go through the extension's migrations
 * and `ctx.DDLManager`, both of which run on the engine's handle, not here.
 *
 * `SET TRANSACTION` is the one SET admitted: it can only narrow the current
 * transaction (`READ ONLY`, an isolation level Postgres accepts only before the
 * first query), and `ai` uses it for its read-only window.
 */
const STATEMENT_KINDS =
  /^[\s(]*(?:select|insert|update|delete|merge|with|values|table|set\s+transaction)\b/i;

/**
 * Functions that leave the sandbox from inside an ordinary SELECT.
 *
 * The statement-kind rule cannot see these, and neither can the table
 * allowlist, because each reaches past it through an argument:
 *
 *   - `set_config` is `SET` spelled as a function. The request transaction runs
 *     as `zveltio_rls` with the tenant in a GUC, and the session user is the
 *     engine's: `set_config('role', 'none', true)` drops back to it, and
 *     `set_config('zveltio.rls_bypass', 'on', true)` switches RLS off for the
 *     rest of the request. `current_setting` (reading) stays legal.
 *   - the server's files and other connections: `pg_read_file`, `lo_import`,
 *     `dblink`, `pg_terminate_backend`, the replication and backup controls.
 *   - `pg_notify`, which speaks on the engine's own realtime and cache channels.
 *   - session advisory locks, which outlive the statement on a pooled
 *     connection (`pg_advisory_xact_lock` ends with the transaction and stays).
 *   - functions that take a query or a relation as a STRING —
 *     `query_to_xml('select token from session', …)`, `table_to_xml`,
 *     `ts_stat`, `crosstab`, `setval('zv_…_seq', …)` — which no table scan reads.
 *
 * A denylist, unlike the rest of this file: Postgres has thousands of
 * functions and an allowlist of them would refuse ordinary SQL. The role is the
 * layer that holds for the worker bridge; for an inline extension this list and
 * the statement-kind rule are what stand between it and the engine role.
 */
const SANDBOX_ESCAPES = new RegExp(
  `^(?:${[
    // session and tenant settings
    'set_config',
    // the server's files and large objects
    'pg_read_file',
    'pg_read_binary_file',
    'pg_stat_file',
    'pg_ls_\\w+',
    'pg_file_\\w+',
    'lo_\\w+',
    'loread',
    'lowrite',
    // other connections and the server itself
    'dblink\\w*',
    'pg_(?:terminate|cancel|signal)_backend',
    'pg_reload_conf',
    'pg_rotate_logfile\\w*',
    'pg_promote',
    'pg_switch_wal',
    'pg_(?:start|stop)_backup',
    'pg_backup_(?:start|stop)',
    'pg_create_restore_point',
    'pg_log_backend_memory_contexts',
    'pg_stat_reset\\w*',
    'pg_logical_\\w+',
    'pg_\\w*replication\\w*',
    'pg_(?:create|copy|drop)_\\w*slot',
    // the engine's notification channels, and locks that outlive the statement
    'pg_notify',
    'pg_(?:try_)?advisory_(?:lock|unlock)\\w*',
    // a query or a relation passed as a string
    '(?:query|cursor|table|schema|database)_to_xml\\w*',
    'ts_stat',
    'ts_rewrite',
    'crosstab\\w*',
    'setval',
  ].join('|')})$`,
  'i',
);

/** The function name before a `(`, quoted or not; schema qualification dropped. */
const CALLEE = /("?)([A-Za-z_][\w$]*)\1\s*$/;

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
      // Postgres ends a line comment at `\r` as well as `\n`; ending it at `\n`
      // only blanked whatever followed a lone `\r`, which Postgres runs.
      const end = sql.slice(i).search(/[\r\n]/);
      const stop = end === -1 ? sql.length : i + end;
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
    // A quoted identifier stays code — it may be the table name — but what is
    // inside it is not a quote, a comment or a dollar sign: `"a'b"` would
    // otherwise open a string that Postgres never sees, and the scan would blank
    // the real SQL up to the next quote.
    if (sql[i] === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j++] === '"') break;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (sql[i] === "'") {
      // `E'…'` takes backslash escapes, so `E'\''` is one quote character and
      // the string ends there. Read as `''`, it ran on and blanked the SQL after
      // it — `SELECT E'\'', (SELECT token FROM session), ''` passed the scan and
      // Postgres returned the token. Only a lone `E`: `date'…'` is a typed literal.
      const escapes = /(?:^|[^\w$])[eE]$/.test(sql.slice(Math.max(0, i - 2), i));
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') {
          j += 2;
          continue;
        }
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
      out += ' '.repeat(Math.min(j, sql.length) - i);
      i = j;
      continue;
    }
    // Dollar-quoted: $tag$ ... $tag$. Not after an identifier character: `$` is
    // one, so Postgres reads `x$$` as the identifier `x$$` and the SQL after it
    // as code, where this scan used to blank it up to the next `$$`.
    const dollar =
      sql[i] === '$' && !/[\w$]/.test(sql[i - 1] ?? '')
        ? /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
        : null;
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
 * One statement, of a kind in `STATEMENT_KINDS`, calling nothing in
 * `SANDBOX_ESCAPES`, naming only tables the extension may reach. Refused before
 * Postgres sees it, so a refusal inside the request transaction aborts nothing.
 */
export function assertWorkerSqlAllowed(
  extName: string,
  sql: string,
  engineTables: ReadonlySet<string>,
  /**
   * Tables this extension may reach beyond the two prefixes: the ones its own
   * migrations create and the ones `EXTENSION_TABLE_GRANTS` names — the same set
   * `createRestrictedDb` takes. Given for inline extensions, whose raw SQL is
   * checked here too; the worker bridge passes none.
   */
  allowedTables?: ReadonlySet<string>,
  channel = 'the worker SQL bridge',
): void {
  const owned = ownedPrefixFor(extName).toLowerCase();
  const granted = new Set([...(allowedTables ?? [])].map((t) => t.toLowerCase()));
  const code = stripNonCode(sql);

  // Checked on the stripped text, so a keyword has to be real code: a
  // `SELECT 'call me'` is a SELECT, and a `;` inside a string ends nothing.
  const refuse = (what: string, why: string): never => {
    throw new WorkerSqlPolicyError(
      `Extension "${extName}" attempted ${what} through ${channel}. ${why}`,
    );
  };
  // One statement. The worker bridge's reserved connection already refuses a
  // second one, but `ctx.db` on the pool sends a parameterless query through
  // the simple-query protocol, which runs `SELECT 1; TRUNCATE "session"` whole —
  // and every rule below reads only the first statement's kind.
  if (code.replace(/[\s;]+$/, '').includes(';')) {
    refuse('more than one statement', 'Send each statement on its own.');
  }
  if (!STATEMENT_KINDS.test(code)) {
    const kind = /^[\s(]*([A-Za-z]+(?:\s+[A-Za-z]+)?)/.exec(code)?.[1] ?? 'an empty statement';
    refuse(
      `"${kind.toUpperCase()}"`,
      'Only SELECT, INSERT, UPDATE, DELETE, MERGE, WITH, VALUES and TABLE run here. ' +
        "Schema changes belong in the extension's migrations or ctx.DDLManager, and " +
        'transactions in ctx.db.transaction().',
    );
  }
  // `SELECT … INTO t` is CREATE TABLE: a table with no RLS, outside the collection
  // registry, that every tenant's requests can read.
  // Found by `indexOf`, not by a regex tried at every offset: a bulk INSERT is
  // tens of kilobytes, and this runs on every statement.
  const lower = code.toLowerCase();
  for (let p = lower.indexOf('into'); p !== -1; p = lower.indexOf('into', p + 4)) {
    // Part of a longer word, a quoted name or a column label (`t.into`).
    if (/[\w$".]/.test(lower[p - 1] ?? '') || /[\w$"]/.test(lower[p + 4] ?? '')) continue;
    if (!/\b(?:insert|merge)\s+$/.test(lower.slice(Math.max(0, p - 12), p))) {
      refuse('SELECT … INTO (creates a table)', "Declare tables in the extension's migrations.");
    }
  }
  for (let p = code.indexOf('('); p !== -1; p = code.indexOf('(', p + 1)) {
    let q = p - 1;
    while (q >= 0 && /\s/.test(code[q]!)) q--;
    // `(` after a comma, an operator or a keyword's parenthesis calls nothing.
    if (!/[\w$"]/.test(code[q] ?? '')) continue;
    // Identifiers are at most 63 bytes in Postgres; 80 covers one quoted.
    const name = CALLEE.exec(code.slice(Math.max(0, p - 80), p))?.[2];
    if (name && SANDBOX_ESCAPES.test(name)) {
      refuse(
        `${name.toLowerCase()}()`,
        'It changes session or tenant settings, reaches the server outside SQL, or takes ' +
          'a query or a table as a string the table policy cannot read.',
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
    // `zvd_` is the collection prefix, and also the prefix of the engine's own
    // metadata: `zvd_permissions` (the Casbin policy table), `zvd_rls_policies`,
    // `zvd_column_permissions`, `zvd_collections`, `zvd_webhooks`… Letting the
    // prefix through let a worker extension write itself a `god` grant whenever
    // the bridge ran as `zveltio_rls` (the fallback where `zveltio_worker` could
    // not be created). Collections are `zvd_*` minus what the engine creates.
    if (ref.table.startsWith('zvd_') && !engineTables.has(ref.table)) continue;
    if (ref.table.startsWith(owned)) continue;
    if (granted.has(ref.table)) continue;
    offenders.add(ref.table);
  }

  if (offenders.size > 0) {
    throw new WorkerSqlPolicyError(
      `Extension "${extName}" attempted to access ${[...offenders].sort().join(', ')} ` +
        `through ${channel}. Extensions may query user data tables ` +
        (allowedTables
          ? `(zvd_*), their own namespace (${ownedPrefixFor(extName)}*) and the tables ` +
            `their migrations create or a grant names only — `
          : `(zvd_*) and their own namespace (${ownedPrefixFor(extName)}*) only — `) +
        `anything else is refused because it was never permitted, which is what ` +
        `makes this an allowlist rather than a list of tables someone remembered.`,
    );
  }
}

/**
 * The engine's own tables, derived from its migrations (`engineOwnedTables`), as
 * `assertWorkerSqlAllowed` takes them. Loaded lazily: `register.ts` is heavy, and
 * this module is also imported where only `ownedPrefixFor` is needed.
 */
export async function workerSqlEngineTables(): Promise<ReadonlySet<string>> {
  const { engineOwnedTables } = await import('./register.js');
  return engineOwnedTables();
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
 * `UPDATE`, `USING`, `TABLE` — rather than by trying to parse SQL. A subquery
 * (`FROM (SELECT …`) does not match, because the next token is a parenthesis
 * and not an identifier; its own inner `FROM` is matched on its own.
 *
 * This does not have to be a complete parser to be a sound allowlist: anything
 * it fails to recognise as a table simply is not granted, and the database role
 * added in migration 043 refuses the statement regardless of what this saw.
 */
function tableReferences(code: string): TableRef[] {
  const IDENT_SRC = '(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)';
  // Where a table list begins. `USING` too: `DELETE FROM a USING b` and
  // `MERGE INTO a USING b` read `b` (Kysely's `deleteFrom().using()` and
  // `mergeInto().using()`); `JOIN … USING (col)` and `USING gin (…)` are a
  // parenthesis or a function call, which the checks below already pass over.
  //
  // `TABLE x` is `SELECT * FROM x`, as a statement or a subquery
  // (`EXISTS (TABLE session)`), so it introduces a table too — but not as a
  // column label (`AS table`, `t.table`) or inside a quoted identifier.
  const INTRO = /\b(?:from|join|into|update|using|table)\b/gi;
  // One entry: `schema.table`, `table`, optionally followed by an alias.
  const ENTRY = new RegExp(`^\\s*(${IDENT_SRC})(?:\\s*\\.\\s*(${IDENT_SRC}))?`, 'i');
  // A word that ends the list. `FROM a, b WHERE …` stops at WHERE; without this
  // the alias-and-comma walk below would run into the rest of the statement.
  // `lateral` joins the list because `JOIN LATERAL (SELECT …)` names no table:
  // the word is a keyword and the parenthesis is a subquery, whose own FROM is
  // matched on its own. Read as an identifier it became a table called
  // `lateral`, and `hr/employees` — which uses `LEFT JOIN LATERAL` — was refused
  // with a message naming a table that does not exist. A reserved word can only
  // be a real table name when quoted, and a quoted one starts with `"`, which
  // this does not match.
  const STOP =
    /^\s*(?:where|group|order|having|limit|offset|on|using|union|intersect|except|returning|set|values|window|for|left|right|inner|outer|full|cross|natural|join|select|as|lateral)\b/i;

  // `FROM` is not always a table list. SQL spells several functions with
  // keyword arguments — `EXTRACT(YEAR FROM now())`, `SUBSTRING(x FROM 2)`,
  // `TRIM(BOTH ' ' FROM name)` — and the word after that FROM is an expression.
  // Read as a table it produced refusals naming `now`, `date`, `start_date` and
  // `invoice_date`, none of which is a table and all of which appear in ordinary
  // first-party SQL.
  const KEYWORD_ARG_FN = /(?:extract|substring|trim|position|overlay)\s*\($/i;
  /** Is this offset inside the parentheses of one of those functions? */
  function insideKeywordArgFn(at: number): boolean {
    let depth = 0;
    for (let i = at - 1; i >= 0; i--) {
      const ch = code[i];
      if (ch === ')') depth++;
      else if (ch === '(') {
        if (depth === 0) return KEYWORD_ARG_FN.test(code.slice(Math.max(0, i - 12), i + 1));
        depth--;
      }
    }
    return false;
  }

  const out: TableRef[] = [];
  for (const intro of code.matchAll(INTRO)) {
    const keyword = intro[0].toLowerCase();
    if (keyword === 'from' && insideKeywordArgFn(intro.index!)) continue;
    // Not table lists either, and both are what Kysely compiles from ordinary
    // builder calls: `FOR UPDATE [OF t] [SKIP LOCKED | NOWAIT]` (the tables it
    // may name must already be in FROM) and `IS [NOT] DISTINCT FROM <expr>`.
    const before = code.slice(Math.max(0, intro.index! - 20), intro.index!);
    if (keyword === 'update' && /\bfor\s+(?:no\s+key\s+)?$/i.test(before)) continue;
    if (keyword === 'from' && /\bis\s+(?:not\s+)?distinct\s+$/i.test(before)) continue;
    // Checked here rather than as a lookbehind in INTRO, which made that regex
    // seventy times slower on a bulk INSERT.
    if (keyword === 'table' && (/[".]$|\bas\s+$/i.test(before) || code[intro.index! + 5] === '"')) {
      continue;
    }
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
      // After FROM, JOIN or USING, an identifier followed directly by `(` is a
      // function call, not a table — `FROM now()`, `FROM generate_series(1, 10)`,
      // `USING gin (col)`.
      //
      // Only after those two. `INSERT INTO zv_scim_tokens (name) VALUES ($1)`
      // puts the column list in exactly that position, and reading it as a
      // function let an engine table straight through. The existing suite caught
      // that on the first run of this change, which is what the case for
      // `zv_scim_tokens` in it is for.
      if (keyword !== 'into' && keyword !== 'update' && /^\s*\(/.test(rest.slice(m[0].length))) {
        break;
      }
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
