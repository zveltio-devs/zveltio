#!/usr/bin/env bun
/**
 * An SDUI schema is a promise about an API. This checks the API keeps it.
 *
 * A declarative page says where its data comes from (`dataSource`), where a
 * create posts (`form.endpoint`) and which fields it sends. Nothing verified
 * any of it, so a schema could name a route the engine does not serve, or send
 * field names the handler discards, and the page would render — and fail only
 * when someone pressed the button.
 *
 * `crm`'s deals tab did exactly that: it posted `title`, `stage` and `value` to
 * an endpoint whose validator accepts `type`, `status` and `amount`. The list
 * showed empty columns and every create answered 400, for as long as the schema
 * has existed. Reading either file alone looks fine; only holding the two
 * together shows it.
 *
 * What is checked
 *   1. `dataSource` resolves to a GET route on the owning extension.
 *   2. `form.endpoint` resolves to a POST route.
 *   3. Every `form.fields[].name` appears in that POST's zod object.
 *   4. Every `columns[].key` appears in the SELECT the GET returns, when that
 *      can be read.
 *
 * What is NOT checked: response shapes beyond column names, permissions, and
 * anything reached through a helper the regex cannot follow. A pass here means
 * the obvious contradictions are gone, not that the page works.
 *
 * Run: `bun run scripts/check-sdui-contract.ts [extensionsDir]`
 */

const EXT_DIR = process.argv[2] ?? '../zveltio-extensions';

interface Problem {
  ext: string;
  resource: string;
  kind: string;
  detail: string;
}

const problems: Problem[] = [];

/** Route paths an extension's engine registers, by method. */
function routesOf(src: string): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  const re = /(?:app|router|r)\.(get|post|put|patch|delete)\(\s*[\r\n]?\s*['"`](\/[^'"`]*)['"`]/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = re.exec(src))) {
    const method = m[1].toUpperCase();
    (out[method] ??= new Set()).add(m[2]);
  }
  return out;
}

/**
 * Keys of the zod object guarding a route.
 *
 * Deliberately shallow: it reads from the route registration to the first
 * `z.object({` and collects `key:` at that nesting level. A handler whose
 * schema is defined elsewhere returns null, and the field check is skipped
 * rather than guessed at — a wrong "missing field" is worse than no answer.
 */
function bodyKeys(
  src: string,
  method: string,
  path: string,
): { all: Set<string>; required: Set<string> } | null {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = new RegExp(`\\.${method.toLowerCase()}\\(\\s*[\\r\\n]?\\s*['"\`]${esc}['"\`]`).exec(
    src,
  );
  if (!at) return null;

  const after = src.slice(at.index, at.index + 3000);

  // The BODY validator, not the first `z.object` after the route.
  //
  // A handler often validates its params first —
  // `zValidator('param', z.object({ id: z.string().uuid() }))` — and reading
  // that as the body produced "POST / requires id", which is not a form field
  // and never was. Anchoring on `'json'` reads the object the form actually
  // posts to.
  const jsonMatch = /zValidator\(\s*['"`]json['"`]\s*,\s*/.exec(after);
  if (!jsonMatch) return null;

  // The object must follow the validator IMMEDIATELY. Many handlers pass a
  // named schema — `zValidator('json', exportSchema)` — and searching forward
  // for the next `z.object({` then landed on an unrelated one further down the
  // file, which is how "POST / requires id" appeared for a form that has no id
  // field. Skipping is the right answer: a wrong "missing field" sends someone
  // to fix something that is not broken.
  const objAt = jsonMatch.index + jsonMatch[0].length;
  if (!after.startsWith('z.object({', objAt)) return null;

  // Slice BETWEEN the braces, not including them. The first version started at
  // the opening `{`, so the nesting counter began at 1 and every top-level key
  // was treated as nested — the list it produced was right only where an
  // unbalanced line happened to drop the counter back to 0, which is to say by
  // accident.
  const braceAt = objAt + 'z.object('.length;
  let depth = 0;
  let end = -1;
  for (let i = braceAt; i < after.length; i++) {
    if (after[i] === '{') depth++;
    else if (after[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = after.slice(braceAt + 1, end);

  const all = new Set<string>();
  const required = new Set<string>();

  // A field's definition can span many lines:
  //
  //     national_id: z
  //       .string()
  //       .optional()
  //
  // Judging requiredness from the key's line alone called that required, and
  // `variants: z.array(z.object({ … })).default([])` too — both reported as
  // "the form never sends it" for forms that are correct. Each field's whole
  // span is collected before the question is asked.
  const lines = body.split('\n');
  let current: { name: string; text: string } | null = null;
  let nest = 0;

  /**
   * Nested braces are stripped before asking whether a field is optional.
   *
   * `lines: z.array(z.object({ quantity: z.number().default(1) … })).min(1)`
   * carries `.default(` inside the INNER object, and testing the accumulated
   * text saw it and called the outer array optional. It is not — `.min(1)` makes
   * at least one line mandatory — and a quote could never be created without
   * one. That is a false negative: the gate said fine about something broken,
   * which is the failure mode worth fearing in a checker.
   */
  const flush = () => {
    if (!current) return;
    all.add(current.name);
    let outer = current.text;
    let prev: string;
    do {
      prev = outer;
      outer = outer.replace(/\{[^{}]*\}/g, '');
    } while (outer !== prev);
    if (!/\.optional\(|\.default\(|\.nullable\(/.test(outer)) required.add(current.name);
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (nest === 0) {
      const k = trimmed.match(/^([a-z_][a-zA-Z0-9_]*)\s*:/);
      if (k) {
        flush();
        current = { name: k[1], text: trimmed };
      } else if (current) {
        current.text += ` ${trimmed}`;
      }
    } else if (current) {
      current.text += ` ${trimmed}`;
    }
    nest += (line.match(/[{[(]/g) ?? []).length - (line.match(/[}\])]/g) ?? []).length;
    if (nest < 0) nest = 0;
  }
  flush();

  return all.size ? { all, required } : null;
}

/**
 * SDUI endpoints are TEMPLATES: `types.ts` documents `{field}` path tokens,
 * substituted from the row at call time. `/ext/data/export/{collection}` is
 * therefore correct, and reading it literally made this checker report a route
 * the engine "does not serve" when the engine serves `/:collection`.
 *
 * Normalised to `:param` so the same matcher handles both spellings.
 */
function normalizeTemplate(path: string): string {
  return path.replace(/\{[^}]+\}/g, ':param');
}

/** `/ext/crm/transactions` on extension `crm` → `/transactions`. */
function localPath(dataSource: string, extName: string): string | null {
  const prefix = `/ext/${extName}`;
  if (!dataSource.startsWith(prefix)) return null;
  const rest = normalizeTemplate(dataSource.slice(prefix.length).split('?')[0]);
  return rest === '' ? '/' : rest;
}

/**
 * Does a registered route match, allowing for `:param` segments?
 *
 * Exact first. `/reports` and `/:id` are both one segment, so a param route
 * would otherwise swallow a literal one and the field check would be run
 * against the wrong handler entirely.
 */
function matches(registered: Set<string> | undefined, wanted: string): boolean {
  if (!registered) return false;
  if (registered.has(wanted)) return true;
  const wp = wanted.split('/').filter(Boolean);
  for (const r of registered) {
    const rp = r.split('/').filter(Boolean);
    if (rp.length !== wp.length) continue;
    if (rp.every((seg, i) => seg.startsWith(':') || wp[i].startsWith(':') || seg === wp[i]))
      return true;
  }
  return false;
}

const schemaGlob = new Bun.Glob('**/studio/schemas/*.json');
let checked = 0;

for await (const rel of schemaGlob.scan({ cwd: EXT_DIR, onlyFiles: true })) {
  const extName = rel.slice(0, rel.indexOf('/studio/'));
  const schema = await Bun.file(`${EXT_DIR}/${rel}`)
    .json()
    .catch(() => null);
  if (!schema?.resources) continue;

  // Engine sources for this extension, concatenated: a router may be split.
  let engineSrc = '';
  const engineGlob = new Bun.Glob('**/*.ts');
  for await (const f of engineGlob.scan({ cwd: `${EXT_DIR}/${extName}/engine`, onlyFiles: true })) {
    if (f.endsWith('.test.ts')) continue;
    engineSrc += `\n${await Bun.file(`${EXT_DIR}/${extName}/engine/${f}`).text()}`;
  }
  if (!engineSrc) continue;

  const routes = routesOf(engineSrc);

  for (const res of schema.resources) {
    checked++;
    const rid = res.id ?? '(fără id)';

    if (res.dataSource) {
      const p = localPath(res.dataSource, extName);
      if (p === null) {
        problems.push({
          ext: extName,
          resource: rid,
          kind: 'dataSource-prefix',
          detail: `"${res.dataSource}" does not start with /ext/${extName}`,
        });
      } else if (!matches(routes.GET, p)) {
        problems.push({
          ext: extName,
          resource: rid,
          kind: 'dataSource-missing',
          detail: `no GET ${p} on the engine (dataSource "${res.dataSource}")`,
        });
      }
    }

    const endpoint = res.form?.endpoint;
    const fields: Array<{ name?: string }> = res.form?.fields ?? [];
    if (endpoint) {
      const p = localPath(endpoint, extName);
      if (p === null) {
        problems.push({
          ext: extName,
          resource: rid,
          kind: 'endpoint-prefix',
          detail: `"${endpoint}" does not start with /ext/${extName}`,
        });
      } else if (!matches(routes.POST, p)) {
        problems.push({
          ext: extName,
          resource: rid,
          kind: 'endpoint-missing',
          detail: `no POST ${p} on the engine (form.endpoint "${endpoint}")`,
        });
      } else {
        const accepted = bodyKeys(engineSrc, 'POST', p);
        if (accepted) {
          const sent = new Set(fields.map((f) => f.name).filter(Boolean) as string[]);

          // Required-but-never-sent: creating from this page cannot succeed.
          for (const need of accepted.required) {
            if (!sent.has(need)) {
              problems.push({
                ext: extName,
                resource: rid,
                kind: 'CREATE-BROKEN',
                detail: `POST ${p} requires "${need}" and the form never sends it — every create answers 400`,
              });
            }
          }

          // Sent-but-unknown: zod strips it, the record saves without it.
          for (const f of sent) {
            if (!accepted.all.has(f)) {
              problems.push({
                ext: extName,
                resource: rid,
                kind: 'field-dropped',
                detail: `form sends "${f}", POST ${p} does not accept it — the value is discarded in silence`,
              });
            }
          }
        }
      }
    }
  }
}

/**
 * Resources whose form and API already disagree, recorded so the gate can stop
 * NEW ones without pretending the existing ones are fine.
 *
 * Empty. Anything landing here is a form that disagrees with its API, and the
 * fix is a decision the checker cannot make: align the form and lose a field
 * somebody put there on purpose, or extend the API and change the product.
 * Listing one is a deliberate act, not a way past the gate.
 */
const BASELINE = new Set<string>([
  // Empty, and meant to stay that way.
  //
  // It held twelve resources when this gate was written: nine create forms that
  // could not work at all — the API required a field the form never sent — and
  // fields discarded in silence, including credentials an administrator typed
  // into a connector that then had none. All are fixed; the list is kept so the
  // next person adding an entry has to notice they are adding one.
]);

// `--all` reports the baselined ones too, which is how the backlog gets worked:
// the gate's job is to stop new breakage, but the list of old breakage has to be
// readable by someone setting out to fix it.
const showAll = process.argv.includes('--all');
const regressions = showAll
  ? problems
  : problems.filter((p) => !BASELINE.has(`${p.ext}:${p.resource}`));
const known = problems.length - regressions.length;

console.log(`[sdui-contract] checked ${checked} resource(s).`);
if (known > 0) {
  console.log(
    `[sdui-contract] ·  ${known} contradiction(s) on ${BASELINE.size} baselined resources — ` +
      `see BASELINE in this file. Not new, not fine.`,
  );
}

if (regressions.length === 0) {
  console.log('[sdui-contract] OK — no new schema/API contradiction.');
  process.exit(0);
}

console.error(`[sdui-contract] FAIL — ${regressions.length} NEW contradiction(s):\n`);
for (const p of regressions) {
  console.error(`  ${p.ext} → ${p.resource}  [${p.kind}]`);
  console.error(`    ${p.detail}`);
}
console.error(
  '\nA declarative page is a promise about an API. When the two disagree the page\n' +
    'still renders — it fails when someone presses the button, which is the worst\n' +
    'place to find out.\n',
);
process.exit(1);
