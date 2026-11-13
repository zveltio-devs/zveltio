/**
 * Extension manifest schema, types, and studio-page embedding.
 *
 * Extracted from `extension-loader.ts` (H-04 split). Owns the single source of
 * truth for what an extension's `manifest.json` may contain (`ManifestSchema`
 * Zod validator), the derived `ExtensionManifest` type, the `ManifestMeta`
 * shape cached for the Studio `/api/extensions` endpoint, and `embedPageSchemas`
 * (reads + inlines declarative studio-page JSON schemas at load time).
 *
 * Kept as a standalone module so the per-phase load helpers can import the
 * manifest type without a circular import back into the loader. The loader
 * re-exports these names so existing import sites keep working.
 */

import { join } from 'path';
import { z } from 'zod';
import { CAPABILITIES, isKnownCapability } from './capabilities.js';
import { parseEgress, SLOT_NAME_RE } from '../edge-functions/egress.js';
import viewSchemaJson from '@zveltio/sdk/view/schema.json' with { type: 'json' };

/** Request headers that carry the caller's credentials; never handed to a worker unasked. */
export const CREDENTIAL_HEADERS = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
] as const;

/** An action's or a job's `input` must compile, or the manifest is refused. */
function inputSchemaIssue(
  ctx: z.RefinementCtx,
  path: (string | number)[],
  what: string,
  input: Record<string, unknown>,
): void {
  try {
    z.fromJSONSchema(input as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `${what}: input is not a usable JSON Schema (${(err as Error).message})`,
    });
  }
}

/** ADR 0039: one route, `/` or literal and `:param` segments — no `*`, no family. */
export const ROUTE_PATH = /^\/$|^(\/([A-Za-z0-9._~-]+|:[A-Za-z_][A-Za-z0-9_]*))+$/;

/**
 * The sub-paths reachable without a session: `publicRoutes` (deprecated by ADR
 * 0039) and the declared `routes` whose access is `public`. What the `/ext/*`
 * gate opens, and what `fromPublicRoutes` and `forwardCredentials` may name.
 */
export function publicRoutePaths(
  m: {
    publicRoutes?: readonly string[];
    routes?: readonly { path: string; access: string }[];
  } | null,
): string[] {
  const declared = (m?.routes ?? []).filter((r) => r.access === 'public').map((r) => r.path);
  return [...new Set([...(m?.publicRoutes ?? []), ...declared])];
}

export const ManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default('1.0.0'),
    category: z.string().default('custom'),
    zveltioMinVersion: z.string().optional(),
    zveltioMaxVersion: z.string().nullable().optional(),
    dependencies: z
      .array(
        z.object({
          name: z.string(),
          minVersion: z.string().optional(),
        }),
      )
      .default([]),
    /**
     * Extensions this one integrates with when they are there. Not installed is
     * not a load error — their services read as absent (`null`). Installed, they
     * load first, and their services are callable as a `dependencies` entry's are.
     */
    optionalDependencies: z
      .array(
        z.object({
          name: z.string(),
          minVersion: z.string().optional(),
        }),
      )
      .default([]),
    /** npm packages auto-installed when extension is activated (e.g. node-saml, ldapts) */
    peerDependencies: z.record(z.string(), z.string()).optional(),
    /** PostgreSQL extensions required in the database (e.g. postgis, pg_trgm) */
    requires: z
      .object({
        postgres_extensions: z.array(z.string()).optional(),
      })
      .optional(),
    /**
     * Declared capabilities — the contract in lib/extensions/capabilities.ts.
     *
     * Validated rather than free-form, because a typo used to be indistinguishable
     * from a deliberate declaration: the field accepted any string and only
     * `db:admin` was ever read, so `"db-admin"` or `"secrets "` would silently
     * grant nothing and fail at runtime somewhere unrelated. An unknown value now
     * fails the manifest.
     *
     * These are what the administrator is shown at install time, and what review
     * actually reviews — auditing a permission set scales, auditing code does not.
     */
    permissions: z
      .array(z.string())
      .default([])
      .superRefine((perms, ctx) => {
        for (const p of perms) {
          if (!isKnownCapability(p)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `Unknown capability "${p}". Known: ${CAPABILITIES.join(', ')}, ` +
                `or net:<host> (e.g. net:api.stripe.com).`,
            });
          }
        }
      }),
    /**
     * Optional pin on the capability contract version. An extension built
     * against a contract this engine no longer speaks refuses to load rather
     * than losing a capability silently.
     */
    capabilityContract: z.number().int().positive().optional(),
    /**
     * Routes that are intentionally reachable WITHOUT a session — declared
     * relative to the extension's mount (`/ext/<name>`). Everything else under
     * `/ext/<name>/*` is fail-closed: the engine's `extensionAuthGate`
     * (middleware/extension-auth-gate.ts) rejects an anonymous request with 401
     * before it ever reaches the handler. So an extension that forgets to guard
     * a route is safe-by-omission (401) instead of exposed-by-omission.
     *
     * Patterns are matched against the sub-path after the mount. `*` matches any
     * run of characters (across `/`), so:
     *   "/webhook/twilio"  → exactly that one route
     *   "/public/*"        → every path under /public/
     *   "/cms/*"           → the public CMS renderer
     * A route that is public-ENTRY but authorizes internally (e.g. a GraphQL
     * endpoint that allows some queries anonymously) is declared here too — the
     * gate only enforces authentication, never authorization.
     *
     * Deprecated by ADR 0039: declare the route in `routes` with `access:
     * "public"`. Still read, and removed in extension-api v2.
     *
     * NOTE: only covers routes under `/ext/<name>`. Extensions that mount on the
     * global app via `ctx.registerPublicRoute` (CDN links, user-deployed
     * webhooks) sit outside this gate by design — see the developer guide.
     */
    publicRoutes: z.array(z.string()).default([]),
    /**
     * ADR 0039: the routes the engine serves under `/ext/<name>`, each answered
     * by the plain function the module exports as `routes[handler]`
     * (`(request, { params, host }) => Response`). `access: "public"` is reached
     * without a session, as a `publicRoutes` entry is (which this replaces);
     * `"caller"` is authenticated as every other extension route. `path` names
     * one route: literal and `:param` segments, no `*`.
     */
    routes: z
      .array(
        z
          .object({
            method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
            path: z.string().regex(ROUTE_PATH),
            access: z.enum(['public', 'caller']),
            handler: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
          })
          .strict(),
      )
      .default([]),
    /**
     * ADR 0039 decision 8: the ways to sign in this extension offers. Each names
     * the declared `public` route that starts it: a `credentials` provider's is a
     * `POST` taking `{ "username", "password" }` as JSON, a `redirect` provider's
     * a `GET` the browser is sent to. `GET /api/sign-in/providers` lists them
     * where the extension is on, so any front end draws its sign-in page from
     * the list. The route signs the person in with `host.identity.signIn`.
     */
    signInProviders: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
            label: z.string().min(1).max(100),
            kind: z.enum(['credentials', 'redirect']),
            route: z.string().regex(ROUTE_PATH),
          })
          .strict(),
      )
      .default([]),
    /**
     * Routes an API key may call, besides a session: `"<METHOD> <pattern>"`,
     * patterns as in `publicRoutes` (`"POST /invoices"`, `"GET /invoices/*"`).
     * The key must hold `{ collection: '$ext:<name>', actions: [...] }` with the
     * method's action — GET read, POST create, PUT/PATCH update, DELETE delete.
     * Undeclared routes answer a key 403 EXT_SESSION_REQUIRED. A handler on a
     * declared route reads the caller from `c.get('user')`: `auth.api.getSession`
     * is null for a key.
     */
    apiKeyRoutes: z.array(z.string().regex(/^(GET|POST|PUT|PATCH|DELETE) \S+$/)).default([]),
    /**
     * Credentials a worker-isolated extension receives on a PUBLIC route, keyed
     * by its `publicRoutes` entry: `{ "/scim/*": ["authorization"] }`.
     *
     * The host strips `CREDENTIAL_HEADERS` from every request it hands a worker:
     * an untrusted extension that saw the caller's cookie or key could replay it
     * as them. A public route that authenticates on its own (an IdP's bearer
     * token) names the header it needs; the operator sees it at install.
     */
    forwardCredentials: z.record(z.string(), z.array(z.enum(CREDENTIAL_HEADERS))).default({}),
    /**
     * Routes this extension mounts on the GLOBAL app via
     * `ctx.registerPublicRoute`, outside `/ext/<name>` and therefore outside
     * the auth gate.
     *
     * Declarative only — the engine does not gate on it, because these routes
     * exist precisely to be reached by callers with no session: an IdP posting
     * SCIM with a bearer token, a search engine fetching /sitemap.xml, a share
     * link. Each authenticates in its own way, which is the extension's job.
     *
     * It is here so the surface is VISIBLE. An audit asked why `/scim/v2/*`
     * was undeclared and read its absence as an oversight; it was documented
     * design, but the manifest still gave an operator no way to see that
     * installing an extension opens a path at the root of their instance. Four
     * extensions do this today. A reviewer reading a manifest should not have
     * to grep the source to find out.
     */
    globalRoutes: z.array(z.string()).default([]),
    /**
     * The paths are chosen by the operator after install, so no list can exist.
     *
     * `developer/edge-functions` is the case: an operator writes a function and
     * gives it a path, and the extension calls `registerPublicRoute` with a
     * value read from a table. It cannot enumerate what it has not been told
     * yet, and the honest statement is not an empty array — that would read as
     * "this extension opens nothing" — but "this extension opens routes whose
     * paths live in data".
     *
     * A boolean rather than a sentinel string in `globalRoutes`, because the
     * sentinel was tried and it broke the extension: the manifest stopped
     * matching this schema, the engine refused to load it with a 422, and the
     * CI gate that should have caught it never ran the extension's manifest
     * through here at all.
     */
    globalRoutesDynamic: z.boolean().default(false),
    /**
     * Authorization resource names this extension guards with
     * `permissionGate(ctx, '<name>')`.
     *
     * Read at load time to create the default grants for the standard roles, so
     * an extension installed after migration 034 is usable by ordinary staff
     * rather than answering 403 to everyone but an administrator. A CI gate in
     * the extensions repository fails the build when a `permissionGate` call
     * names something absent from here.
     *
     * NOT `permissions`, which is the capability list the HOST grants to the
     * extension. This is the list an OPERATOR grants to their people. Same word
     * in English, opposite directions.
     */
    /**
     * Message-key namespaces this extension owns, e.g. `["invoicing",
     * "finance.invoice"]`.
     *
     * DECLARED, never derived from the directory path. Deriving it was tried
     * on 2026-08-10 and reverted before commit: the rule "every key starts
     * with the extension path" would have flagged 106 correct keys at
     * `finance/invoicing`, which owns `invoicing.*` — the two do not
     * correspond.
     *
     * A LIST, and of variable depth, because a single exclusive top-level
     * prefix does not describe reality either: `finance.*` is written by six
     * extensions (accounting, banking, expenses, invoicing, quotes,
     * subscriptions) and `content.*` by six more. Measured over the 56
     * shipping catalogues, 43 extensions need one namespace and 13 need two;
     * at the depth each actually claims, no two extensions overlap.
     *
     * Why it must be declared at all: catalogues now travel to the host
     * (`GET /api/extensions?messages=<locale>`), and a host merges them with
     * last-one-wins. Disjointness is what makes that merge safe, and it holds
     * today by discipline alone — 0 collisions across 2309 keys. This field is
     * what lets a gate keep it true, and lets a third-party host attribute a
     * key to the extension responsible for it.
     *
     * `common.*` is NOT declarable here: it is the host's shared vocabulary
     * (interface verbs), which every extension may reference and none owns.
     */
    i18nPrefixes: z.array(z.string().regex(/^[a-z][a-zA-Z0-9-]*(\.[a-zA-Z0-9_-]+)*$/)).default([]),
    resources: z.array(z.string()).default([]),
    /**
     * Which of `resources` are withheld from the automatic default grant.
     *
     * Core withholds `employees`, `payroll`, `leave` and `banking` on the view
     * that some data an employer holds because the law requires it, not because
     * colleagues should read it. Core cannot make that judgement about an
     * extension it has never seen — only the extension knows it stores medical
     * records or disciplinary files — so it declares them and they stay closed
     * until a role is granted them by name.
     */
    sensitiveResources: z.array(z.string()).default([]),
    /**
     * Synchronous business logic the engine serves at `POST /ext/<name>/actions/<action>`
     * (RFC v3 "Actions"): the caller must hold `permission` on one of `resources`
     * or on a collection the actions or jobs read or write,
     * the body must match `input` (JSON Schema), and the implementation reaches
     * only the collections in `reads` and `writes`, inside the request transaction.
     * `"*"` in either list reaches any collection, only as the caller (ADR 0047):
     * the data API with the caller's grants, row and column rules, never as the
     * system; consented as `collections:any:read` / `collections:any:write`.
     */
    actions: z
      .array(
        z.object({
          name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
          permission: z.object({
            resource: z.string().min(1),
            action: z.string().min(1).default('execute'),
          }),
          input: z.record(z.string(), z.unknown()),
          reads: z.array(z.string()).default([]),
          writes: z.array(z.string()).default([]),
          /** The `jobs` this action may enqueue (`ActionHost.enqueue`). */
          enqueues: z.array(z.string()).default([]),
          /**
           * The actions of other extensions this one may run (`ActionHost.actions.run`),
           * as `<extension>.<action>`; each extension must be in `dependencies` or
           * `optionalDependencies` (ADR 0014) — an absent optional one answers 404.
           */
          calls: z.array(z.string()).default([]),
        }),
      )
      .default([]),
    /**
     * Asynchronous work (RFC v3 "Jobs"): an action enqueues one in its request
     * transaction, and the engine runs it after that commits, out of any request,
     * in the enqueuing tenant. `input` is a JSON Schema checked at enqueue; the
     * implementation reaches only the collections in `reads` and `writes`, never
     * `"*"`: a job acts as the extension, with no caller to bound it (ADR 0047).
     * `retry.limit` failed runs are retried, with exponential `backoff` by default.
     */
    jobs: z
      .array(
        z.object({
          name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
          input: z.record(z.string(), z.unknown()),
          reads: z.array(z.string()).default([]),
          writes: z.array(z.string()).default([]),
          /**
           * `publicRoutes` entries (each one route, no `*`) whose handler may enqueue this job with
           * `ctx.internals.enqueue` (ADR 0018): a signed inbound webhook stores
           * the event and leaves the writes to the job.
           */
          fromPublicRoutes: z.array(z.string()).default([]),
          retry: z
            .object({
              limit: z.number().int().min(0).max(10).default(2),
              backoff: z.boolean().default(true),
            })
            .default({ limit: 2, backoff: true }),
          /**
           * Authorities the job may fetch (ADR 0022 decision 5), each exact as
           * an edge function's (`api.x.com`, `api.x.com:8443`; no wildcard; IDN
           * in `xn--`). A job that declares any runs in the Deno runner, and
           * each one reaches the network only once an administrator approves
           * it as the capability `egress:<authority>`.
           */
          egress: z.array(z.string()).default([]),
          /**
           * Slots for hosts the operator chooses (ADR 0026 decision 2): an AI
           * provider's base URL, a tenant's REST API. The manifest names the
           * slot; an operator binds its authorities as `egress:<slot>=…`, and
           * until then the slot reaches nothing. A job that declares any runs
           * in the Deno runner. Read the binding with `host.egress.slot(name)`.
           *
           * `{ name, kind: "tcp" }` declares a TCP slot (ADR 0026 amendment):
           * each bound authority carries a port, and the job opens a relayed
           * stream with `host.egress.connect(name, …)`; it never holds a socket.
           * A bare name is `kind: "http"`.
           */
          egressSlots: z
            .array(
              z.union([
                z.string().regex(SLOT_NAME_RE, 'a slot name is [a-z][a-z0-9_]*'),
                z
                  .object({
                    name: z.string().regex(SLOT_NAME_RE, 'a slot name is [a-z][a-z0-9_]*'),
                    kind: z.enum(['http', 'tcp']).default('http'),
                  })
                  .strict(),
              ]),
            )
            .default([]),
          /**
           * Ceilings of a run in the Deno runner (ADR 0022 decision 5); an inline
           * run ignores them. Without egress the run holds one transaction, so
           * its time limit is the database's idle-in-transaction limit, 60 s;
           * with egress each host call has its own, and the limit is 900 s.
           */
          memoryMb: z.number().int().min(32).max(512).default(128),
          timeoutSeconds: z.number().int().min(1).max(900).default(60),
        }),
      )
      .default([]),
    /**
     * The collections this extension declares (ADR 0012): each has
     * `schema/collections/<name>.json` in the package, in the schema-as-code
     * collection format. The engine creates them, and records itself as their
     * owner, when a god enables the extension; never at install.
     */
    collections: z
      .array(
        z
          .string()
          .max(63)
          .regex(/^[a-z][a-z0-9_]*$/),
      )
      .default([]),
    contributes: z
      .object({
        engine: z.boolean().default(true),
        studio: z.boolean().default(false),
        client: z.boolean().default(false),
        fieldTypes: z.array(z.string()).default([]),
        stepTypes: z.array(z.string()).default([]),
        collections: z.array(z.string()).default([]),
        /** Named Studio composition slots this extension registers via contribute.ts. */
        slots: z.array(z.string()).default([]),
      })
      .optional(),
    /**
     * Resource quotas. Extensions exceeding any limit fail install with
     * EXT_QUOTA_EXCEEDED. Defaults are generous enough for current extensions;
     * publishers wanting a smaller footprint can tighten them per-extension.
     */
    quotas: z
      .object({
        bundleSizeKbMax: z.number().int().positive().default(50_000),
        nodeModulesSizeMbMax: z.number().int().positive().default(200),
        migrationsMax: z.number().int().positive().default(100),
      })
      .optional(),
    /**
     * Extension runtime. `"js"` is the only one: an ESM module, run inline or
     * in the extension runner. `"wasm"` is refused — the in-process WASM host
     * it selected was removed (rfc-extension-runner.md, Alternatives
     * considered), and while it existed a `runtime: "wasm"` manifest with
     * `engine.isolation: "worker"` passed the publisher-tier gate and then
     * ran in the engine process.
     */
    runtime: z.literal('js').default('js').optional(),
    /**
     * v2 engine block. When present with `bundled: true`, the loader
     * imports `engine.entry` (a pre-built `.js` artifact) directly
     * without checking for the CORE_NPM_PACKAGES on disk — the bundle
     * has them inlined.
     */
    engine: z
      .object({
        entry: z.string(),
        format: z.literal('esm').default('esm'),
        target: z.enum(['bun', 'node', '*']).default('bun'),
        bundled: z.boolean(),
        bundlePeers: z.boolean().default(false),
        /**
         * Isolation strategy. `'inline'` (default) runs the extension
         * in the engine's main thread — same as today, max speed and
         * full access. `'worker'` runs each enabled extension in a
         * process of its own (the extension runner in production); it
         * has no DATABASE_URL, no service
         * registry write access, and all SQL is proxied through the
         * host. Use for third-party / untrusted extensions where
         * security trumps the +0.5-2ms IPC overhead per route hit.
         * The threat model is in docs/extensions/overview.md.
         */
        isolation: z.enum(['inline', 'worker']).default('inline'),
      })
      .optional(),
    integrity: z
      .object({
        // Absent from a Studio-only extension, which has no bundle.
        engineSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        // ADR 0012: the declared schema files, checked at load (`readDeclaredCollections`).
        schemaSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        // ADR 0022: `engine/jobs.js`, the job bundle the Deno runner runs, checked at load.
        jobsSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        // archiveSha256 is computed by the registry on upload. The pack
        // command writes an empty string as a placeholder (registry fills
        // it in later); accept either missing/empty OR a valid hash.
        archiveSha256: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/)]).optional(),
      })
      .optional(),
  })
  .passthrough()
  .superRefine((m, ctx) => {
    if (new Set(m.collections).size !== m.collections.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collections'],
        message: 'a collection is declared twice',
      });
    }
    const names = new Set<string>();
    // `"*"` (ADR 0047) names no collection, and is no Casbin object to gate on.
    const collections = new Set(
      [...m.actions, ...m.jobs].flatMap((e) => [...e.reads, ...e.writes]),
    );
    collections.delete('*');
    m.actions.forEach((a, i) => {
      if (names.has(a.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', i, 'name'],
          message: `action "${a.name}" is declared twice`,
        });
      }
      names.add(a.name);
      // Granted and refused per resource: one this manifest does not declare
      // gets no default grants and no place in the role editor. A collection
      // its actions or jobs read or write is declared (extension model v3): the engine
      // grants `execute` on it once it exists.
      if (!m.resources.includes(a.permission.resource) && !collections.has(a.permission.resource)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', i, 'permission', 'resource'],
          message: `action "${a.name}" is gated on "${a.permission.resource}", which is neither in resources nor a collection the actions or jobs read or write`,
        });
      }
      inputSchemaIssue(ctx, ['actions', i, 'input'], `action "${a.name}"`, a.input);
      for (const job of a.enqueues) {
        if (!m.jobs.some((j) => j.name === job)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['actions', i, 'enqueues'],
            message: `action "${a.name}" enqueues "${job}", which is not in jobs`,
          });
        }
      }
      for (const call of a.calls) {
        const dot = call.lastIndexOf('.');
        const ext = call.slice(0, dot);
        if (dot < 1 || !/^[a-z][a-zA-Z0-9]*$/.test(call.slice(dot + 1))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['actions', i, 'calls'],
            message: `action "${a.name}" calls "${call}", which is not "<extension>.<action>"`,
          });
        } else if (![...m.dependencies, ...m.optionalDependencies].some((d) => d.name === ext)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['actions', i, 'calls'],
            message: `action "${a.name}" calls "${call}", but "${ext}" is not in dependencies or optionalDependencies`,
          });
        }
      }
    });
    const publicPaths = publicRoutePaths(m);
    const seenRoutes = new Set<string>();
    m.routes.forEach((r, i) => {
      const issue = seenRoutes.has(`${r.method} ${r.path}`)
        ? `route ${r.method} ${r.path} is declared twice`
        : r.path === '/actions' || r.path.startsWith('/actions/')
          ? `route ${r.path}: /actions is the engine's (POST /actions/<action>)`
          : null;
      if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routes', i], message: issue });
      seenRoutes.add(`${r.method} ${r.path}`);
    });
    const providerIds = new Set<string>();
    m.signInProviders.forEach((p, i) => {
      const method = p.kind === 'credentials' ? 'POST' : 'GET';
      const issue = providerIds.has(p.id)
        ? `sign-in provider "${p.id}" is declared twice`
        : m.routes.some(
              (r) => r.method === method && r.path === p.route && r.access === 'public',
            ) && !p.route.includes(':')
          ? null
          : `sign-in provider "${p.id}" (${p.kind}) starts at ${method} ${p.route}, which is not a declared public route without parameters`;
      if (issue) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['signInProviders', i], message: issue });
      }
      providerIds.add(p.id);
    });
    const jobNames = new Set<string>();
    const slotKinds = new Map<string, string>();
    m.jobs.forEach((j, i) => {
      if (jobNames.has(j.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['jobs', i, 'name'],
          message: `job "${j.name}" is declared twice`,
        });
      }
      jobNames.add(j.name);
      for (const kind of ['reads', 'writes'] as const) {
        if (j[kind].includes('*')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['jobs', i, kind],
            message: `job "${j.name}" lists "*" in ${kind}: only an action reaches any collection, as its caller (ADR 0047); a job lists each one`,
          });
        }
      }
      inputSchemaIssue(ctx, ['jobs', i, 'input'], `job "${j.name}"`, j.input);
      try {
        parseEgress(j.egress);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['jobs', i, 'egress'],
          message: `job "${j.name}": ${(err as Error).message}`,
        });
      }
      const slotNames = j.egressSlots.map((s) => (typeof s === 'string' ? s : s.name));
      if (new Set(slotNames).size !== slotNames.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['jobs', i, 'egressSlots'],
          message: `job "${j.name}": an egress slot is declared twice`,
        });
      }
      // One binding per slot name serves every job: its kind is one too.
      for (const s of j.egressSlots) {
        const [name, kind] = typeof s === 'string' ? [s, 'http'] : [s.name, s.kind];
        const seen = slotKinds.get(name);
        if (seen !== undefined && seen !== kind) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['jobs', i, 'egressSlots'],
            message: `job "${j.name}": slot "${name}" is declared both "${seen}" and "${kind}"`,
          });
        }
        slotKinds.set(name, kind);
      }
      if (j.egress.length === 0 && j.egressSlots.length === 0 && j.timeoutSeconds > 60) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['jobs', i, 'timeoutSeconds'],
          message: `job "${j.name}": timeoutSeconds above 60 needs egress (the run holds one transaction)`,
        });
      }
      for (const route of j.fromPublicRoutes) {
        // One route, not a family: a `*` would let every public handler under it queue the job.
        if (route.includes('*')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['jobs', i, 'fromPublicRoutes'],
            message: `job "${j.name}" names "${route}" in fromPublicRoutes; name one route, without "*"`,
          });
        } else if (!publicPaths.includes(route)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['jobs', i, 'fromPublicRoutes'],
            message: `job "${j.name}" names "${route}" in fromPublicRoutes, which is not a publicRoutes entry`,
          });
        }
      }
    });
    for (const route of Object.keys(m.forwardCredentials)) {
      if (!publicPaths.includes(route)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['forwardCredentials', route],
          message: `forwardCredentials names "${route}", which is not a publicRoutes entry`,
        });
      }
    }
    // `studio` is passthrough; only `surface`, new in v1, is checked here, and
    // only when a page sets it, so no manifest that loaded before stops loading.
    // A Console page lives under /admin, an App page under /app/<this extension>
    // (ADR 0006): an App page elsewhere would mount in another extension's space.
    const pages = (m as { studio?: { pages?: unknown } }).studio?.pages;
    if (!Array.isArray(pages)) return;
    pages.forEach((p: { path?: unknown; surface?: unknown }, i) => {
      if (p?.surface === undefined) return;
      const path = typeof p.path === 'string' ? p.path : '';
      const ok =
        p.surface === 'console'
          ? path.startsWith('/admin/')
          : p.surface === 'app'
            ? path === `/app/${m.name}` || path.startsWith(`/app/${m.name}/`)
            : false;
      if (ok) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['studio', 'pages', i, 'surface'],
        message:
          p.surface === 'console' || p.surface === 'app'
            ? `page "${path}" is marked ${p.surface}, so its path must start with ${p.surface === 'console' ? '/admin/' : `/app/${m.name}`}`
            : `surface must be "console" or "app"`,
      });
    });
  });

export interface ManifestMeta {
  displayName?: string;
  description?: string;
  category?: string;
  contributes?: { engine?: boolean; studio?: boolean; client?: boolean };
  /** Message-key namespaces this extension owns — see `ManifestSchema.i18nPrefixes`.
   *  Carried to the host so it can attribute a key to its owner. */
  i18nPrefixes?: string[];
  /** The collections it declares (ADR 0012): a declarative page may name their data API. */
  collections?: string[];
  /** Present only when the caller asked for a locale (`?messages=<locale>`):
   *  this extension's own catalogue, flat `key → text`. The host merges the
   *  per-extension catalogues itself; the engine never unions them. */
  messages?: Record<string, string>;
  studio?: {
    navGroup?: string;
    pages?: Array<{
      path: string;
      label: string;
      icon?: string;
      /** Declarative page: a relative path under studio/ to a JSON schema
       * (in the manifest), replaced at load time by the parsed schema object
       * + `render: 'schema'` so the Studio renders it without per-host build. */
      schema?: unknown;
      render?: 'schema';
      /** Where the page mounts (ADR 0006): `console` (the default) under
       * /admin, `app` under /app/<extension>. Hosts show only their own. */
      surface?: 'console' | 'app';
    }>;
  };
}

/**
 * Full parsed manifest type.
 *
 * Derived from the runtime Zod validator (`ManifestSchema`) rather than
 * `json-schema-to-ts` over `docs/manifest-v2.schema.json` (which H-04 proposed):
 * `z.infer` guarantees the type is exactly what `ManifestSchema.parse()` accepts
 * and returns at runtime — a stronger single-source guarantee than a mirror
 * JSON schema that nothing enforces. The `.passthrough()` fields the loader
 * reads but the strict object doesn't enumerate (`displayName`, `description`,
 * `studio`) are added explicitly so callers get real types, not `unknown`.
 */
export type ExtensionManifest = z.infer<typeof ManifestSchema> & {
  displayName?: string;
  description?: string;
  studio?: ManifestMeta['studio'];
};

/** `zveltio.view/2` (ADR 0042), compiled on first use from the JSON Schema the SDK publishes. */
let viewV2: z.ZodType | undefined;

type Issue = { code: string; path: PropertyKey[]; message: string; errors?: Issue[][] };

/** A failed union reports its closest branch (the fewest issues), at full depth. */
function flatIssues(issues: Issue[], base: PropertyKey[] = []): Issue[] {
  return issues.flatMap((i) =>
    i.code === 'invalid_union' && i.errors?.length
      ? flatIssues(
          i.errors.reduce((a, b) => (b.length < a.length ? b : a)),
          [...base, ...i.path],
        )
      : [{ ...i, path: [...base, ...i.path] }],
  );
}

/**
 * Why a page schema that declares `zveltio.view/2` is refused, or `null`. A
 * `view/1` schema (no `spec`) is not checked here: it keeps rendering as before.
 * The CLI runs the same schema at `extension validate` and `pack`; names
 * (collections, actions, panes, message keys) are checked there and by the
 * gates at run time, not here: the engine does not load the SDK's code.
 *
 * `jsonSchema` is for tests. A schema that does not compile refuses the page
 * with that reason; it never fails the extension's load.
 */
export function viewRefusal(schema: unknown, jsonSchema: unknown = viewSchemaJson): string | null {
  if ((schema as { spec?: unknown }).spec !== 'zveltio.view/2') return null;
  let validator: z.ZodType;
  try {
    const compile = () => z.fromJSONSchema(jsonSchema as Parameters<typeof z.fromJSONSchema>[0]);
    if (jsonSchema === viewSchemaJson) {
      viewV2 ??= compile();
      validator = viewV2;
    } else {
      validator = compile();
    }
  } catch (e) {
    return `the view/2 schema did not compile (${(e as Error).message})`;
  }
  const r = validator.safeParse(schema);
  if (r.success) return null;
  return flatIssues(r.error.issues as unknown as Issue[])
    .slice(0, 3)
    .map((i) => `/${i.path.map(String).join('/')}: ${i.message}`)
    .join('; ');
}

/**
 * For each manifest studio page that names a JSON schema file, read + parse it
 * and inline the parsed object (so /api/extensions delivers it with no extra
 * round-trip and no per-host build). Read once at load; failures degrade
 * gracefully: a file that does not load, or a `view/2` that fails its schema,
 * leaves the page without a schema, so nothing invalid is served.
 */
export async function embedPageSchemas(
  extDir: string,
  studio: ManifestMeta['studio'],
): Promise<ManifestMeta['studio']> {
  if (!studio?.pages?.length) return studio;
  const pages = await Promise.all(
    studio.pages.map(async (p) => {
      let schema = p.schema;
      if (typeof schema === 'string') {
        try {
          schema = JSON.parse(await Bun.file(join(extDir, 'studio', schema)).text()) as unknown;
        } catch (e) {
          console.warn(`⚠️  Extension schema "${p.schema}" failed to load: ${(e as Error).message}`);
          return p;
        }
      }
      if (schema === undefined || schema === null || typeof schema !== 'object') return p;
      const refused = viewRefusal(schema);
      if (refused !== null) {
        console.warn(`⚠️  Extension page "${p.path}" is not a valid view/2, not served: ${refused}`);
        return { ...p, schema: undefined };
      }
      return { ...p, schema, render: 'schema' as const };
    }),
  );
  return { ...studio, pages };
}

/**
 * A locale name that is safe to put in a filesystem path.
 *
 * The locale reaches this module from a query string
 * (`GET /api/extensions?messages=<locale>`), and it is concatenated into a
 * path under the extension directory. Anything but this shape — `..`, a
 * slash, a NUL — is refused before it can be joined, so the parameter cannot
 * address a file outside `<extDir>/studio/messages/`.
 */
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

export function isSupportedLocaleName(locale: string): boolean {
  return LOCALE_RE.test(locale);
}

/**
 * Read one extension's own message catalogue for one locale.
 *
 * Deliberately per-extension and unmerged. The engine ships an extension's
 * catalogue the way it ships its page schema — as an opaque artefact belonging
 * to that extension — and never unions the catalogues into a single answer.
 * Merging would make the engine the owner of a global namespace, which is the
 * thing deleted on 2026-08-10 when `routes/translations.ts` (366 lines, 15
 * routes) came out: the engine knows HOW it accepts an extension, never WHAT a
 * particular extension says. The host merges, because the host owns
 * `common.*` and decides precedence.
 *
 * Returns undefined when the extension ships no catalogue for that locale —
 * which is normal (an extension may translate only some of the nine) and must
 * not be reported as an error.
 */
export async function loadExtensionMessages(
  extDir: string,
  locale: string,
): Promise<Record<string, string> | undefined> {
  if (!isSupportedLocaleName(locale)) return undefined;
  const path = join(extDir, 'studio', 'messages', `${locale}.json`);
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      // `$schema` is an editor affordance in the source file, not a message.
      if (k === '$schema') continue;
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    // Missing file is the common case; a malformed one is the extension's bug
    // and must not take the whole /api/extensions response down with it.
    return undefined;
  }
}
