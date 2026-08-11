/**
 * Fail-closed `/ext/*` auth-gate contract probe (live engine).
 *
 * Companion to probe-sdui-endpoints.ts. Boots nothing itself — it runs against
 * an already-serving engine (the runtime-probe CI job) with EXTENSIONS_DIR
 * pointing at a checkout of zveltio-extensions.
 *
 * The invariant it enforces, for every extension whose manifest declares
 * `publicRoutes`:
 *   1. Each declared public pattern is reachable ANONYMOUSLY — an unauthenticated
 *      request must NOT get 401 (the gate let it through). A 401 here means the
 *      declaration is wrong or the gate stopped honoring it → a public webhook /
 *      storefront / CMS page is broken.
 *   2. A synthetic NON-declared path under the same extension IS 401 for an
 *      anonymous caller — proving the gate is actually mounted and enforcing.
 *      A non-401 here means the gate is off → every extension route is exposed.
 *
 * This is the regression net for the "forgot to guard an /ext route" bug class
 * (postgis geofences, the SMS/Twilio webhooks) — with the gate, a forgotten
 * route is 401 by default; this probe keeps the gate honest and the declarations
 * matching reality.
 *
 * Usage: BASE_URL=… bun scripts/probe-ext-auth.ts [extensions-root]
 * Exit code 1 on any violation (HARD-fails the CI job).
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
/**
 * The problem `code` the fail-closed `/ext/*` gate answers with. Anything else
 * on a 401 came from the extension's own handler.
 */
const GATE_CODE = 'EXT_AUTH_REQUIRED';

const EXT_ROOT = process.argv[2] ?? process.env.EXTENSIONS_DIR ?? process.cwd();

const TEST_EMAIL = process.env.TEST_EMAIL ?? 'probe@test.invalid';
const TEST_PASS = process.env.TEST_PASS ?? 'ProbePass123!';

interface ManifestLite {
  name: string;
  publicRoutes?: string[];
}

function findManifests(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) findManifests(full, acc);
    else if (entry === 'manifest.json') acc.push(full);
  }
  return acc;
}

async function signIn(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!cookie) throw new Error(`sign-in failed (${res.status}) — is the god user created?`);
  return cookie;
}

/** Turn a publicRoutes pattern into a concrete probe path (`*` → `x`). */
function concreteUrl(extName: string, pattern: string): string {
  const sub = (pattern.startsWith('/') ? pattern : `/${pattern}`).replace(/\*/g, 'x');
  return `/ext/${extName}${sub}`;
}

const manifests: ManifestLite[] = findManifests(EXT_ROOT)
  .map((p) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as ManifestLite;
    } catch {
      return null;
    }
  })
  .filter(
    (m): m is ManifestLite => !!m && Array.isArray(m.publicRoutes) && m.publicRoutes.length > 0,
  );

if (manifests.length === 0) {
  console.log('ℹ️  No extensions declare publicRoutes — nothing to probe.');
  process.exit(0);
}

const cookie = await signIn();
const failures: string[] = [];
const softSkips: string[] = [];
let publicChecks = 0;

for (const m of manifests) {
  const enc = encodeURIComponent(m.name);
  // Enable so the extension's routes + gate registration are live. An enable
  // failure (e.g. 422 for an unmet dependency or a missing PG extension) is a
  // SOFT condition — the extension simply isn't active in this environment, so
  // we skip its checks rather than fail the build. Mirrors the SDUI probe's
  // soft/hard model.
  const enableRes = await fetch(`${BASE}/api/marketplace/${enc}/enable`, {
    method: 'POST',
    headers: { Cookie: cookie },
  }).catch(() => null);
  const active = !!enableRes && (enableRes.ok || enableRes.status === 409);
  if (!active) {
    softSkips.push(`${m.name} (enable → ${enableRes?.status ?? 'no-response'})`);
    continue;
  }

  // (1) Each declared public pattern must not be blocked BY THE GATE.
  //
  // Not "must not return 401". A route can be public to the gate and still
  // refuse an anonymous caller for its own reasons — `developer/api-docs`
  // serves its spec only when an administrator has switched the docs public,
  // and answers 401 otherwise. That is the route deciding, which is exactly
  // what declaring it public is FOR: the gate steps aside so the handler can
  // choose.
  //
  // The two are distinguishable and the difference is the whole point of this
  // check, so it compares the problem CODE: the gate answers
  // `EXT_AUTH_REQUIRED`, a handler answers whatever it likes. Checking the
  // status alone reported a correctly-configured extension as a gate failure.
  for (const pattern of m.publicRoutes ?? []) {
    const url = concreteUrl(m.name, pattern);
    const res = await fetch(`${BASE}${url}`).catch(() => null);
    publicChecks++;
    if (res && res.status === 401) {
      const code = await res
        .clone()
        .json()
        .then((b: { code?: string }) => b?.code)
        .catch(() => undefined);
      if (code === GATE_CODE) {
        failures.push(
          `${m.name}: declared public route "${pattern}" (${url}) was blocked BY THE GATE ` +
            `(code ${GATE_CODE}) for an anonymous caller — the manifest says it is public.`,
        );
      }
    }
  }

  // (2) A non-declared path under the extension must be 401 anonymously —
  // proves the gate is mounted + enforcing for this extension.
  const control = `/ext/${m.name}/__auth_gate_control__`;
  const res = await fetch(`${BASE}${control}`).catch(() => null);
  // Here the code is not compared: any 401 on a path no route serves can only
  // have come from the gate, and demanding a specific code would make this
  // brittle for no gain.
  if (!res || res.status !== 401) {
    failures.push(
      `${m.name}: control path ${control} returned ${res?.status ?? 'no-response'} for an ` +
        `anonymous caller, expected 401 — the fail-closed gate is NOT enforcing.`,
    );
  }
}

console.log(
  `\n— ext-auth probe: ${manifests.length} declaring extensions, ${publicChecks} public-route checks, ${softSkips.length} soft-skipped`,
);
if (softSkips.length > 0) {
  console.log(`   ⚠️  soft-skipped (not active here): ${softSkips.join(', ')}`);
}
if (failures.length > 0) {
  console.error(`\n❌ ext-auth gate probe FAILED (${failures.length}):`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log('✓ Fail-closed /ext/* auth gate holds: public routes reachable, gate enforcing.');
