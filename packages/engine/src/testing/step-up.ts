/**
 * A software authenticator and TOTP device for driving step-up (lib/step-up.ts)
 * the way a browser does: real WebAuthn registration and assertion bytes signed
 * with an ES256 key, real RFC 6238 codes — the verifier is never mocked.
 *
 * `req` is anything that answers a path: the in-process `app.request`, or a
 * fetch bound to an out-of-process engine's base URL. `origin` must be the
 * engine's BETTER_AUTH_URL (in-process: `passkeyRelyingParty().origin`).
 */
import { createHash, createHmac } from 'node:crypto';

export type Req = (path: string, init?: RequestInit) => Response | Promise<Response>;

export interface SoftPasskey {
  credentialId: Uint8Array;
  keys: CryptoKeyPair;
  counter: number;
}

const b64url = (b: Uint8Array | ArrayBuffer) => Buffer.from(b as Uint8Array).toString('base64url');
const sha256 = (b: Uint8Array | string) => new Uint8Array(createHash('sha256').update(b).digest());
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

// Just enough CBOR for an attestation object and a COSE key.
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | Record<string, unknown>;
function cborHead(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
}
function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') {
    const b = new TextEncoder().encode(v);
    return concat(cborHead(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(cborHead(2, v.length), v);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return concat(
    cborHead(5, entries.length),
    ...entries.flatMap(([k, val]) => [cbor(k as Cbor), cbor(val as Cbor)]),
  );
}

/** WebCrypto signs ECDSA as raw r||s; WebAuthn carries DER. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
}
const joinCookies = (...cs: string[]) => cs.filter(Boolean).join('; ');

export async function newSoftPasskey(): Promise<SoftPasskey> {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return { credentialId: crypto.getRandomValues(new Uint8Array(16)), keys, counter: 0 };
}

/**
 * Register `pk` on the session's account through Better Auth's own endpoints.
 * `extra` is what the step-up gate asks for: `{ password }` for a first factor,
 * a step-up header for any later one. Returns the verify-registration response.
 */
export async function registerSoftPasskey(
  req: Req,
  cookie: string,
  pk: SoftPasskey,
  origin: string,
  extra: { password?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const optsRes = await req('/api/auth/passkey/generate-register-options', {
    headers: { cookie },
  });
  if (!optsRes.ok) throw new Error(`register options: ${optsRes.status} ${await optsRes.text()}`);
  const opts = (await optsRes.json()) as { challenge: string; rp: { id: string } };
  const jwk = await crypto.subtle.exportKey('jwk', pk.keys.publicKey);
  const coseKey = new Map<Cbor, Cbor>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
    [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
  ]);
  const authData = concat(
    sha256(opts.rp.id),
    new Uint8Array([0x45]), // UP | UV | AT
    new Uint8Array(4),
    new Uint8Array(16), // AAGUID
    new Uint8Array([0, pk.credentialId.length]),
    pk.credentialId,
    cbor(coseKey),
  );
  const clientDataJSON = JSON.stringify({
    type: 'webauthn.create',
    challenge: opts.challenge,
    origin,
    crossOrigin: false,
  });
  const id = b64url(pk.credentialId);
  return req('/api/auth/passkey/verify-registration', {
    method: 'POST',
    // A browser sends Origin; Better Auth refuses a POST without one outside
    // NODE_ENV=test (MISSING_OR_NULL_ORIGIN).
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      cookie: joinCookies(cookie, cookieOf(optsRes)),
      ...extra.headers,
    },
    body: JSON.stringify({
      name: 'soft',
      password: extra.password,
      response: {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64url(new TextEncoder().encode(clientDataJSON)),
          attestationObject: b64url(cbor({ fmt: 'none', attStmt: {}, authData })),
          transports: ['internal'],
        },
      },
    }),
  });
}

/**
 * An assertion over `challenge`, as `navigator.credentials.get` would return it.
 * `uv: false` is a security key with no PIN set: present, not verified.
 */
export async function softAssertion(
  pk: SoftPasskey,
  challenge: string,
  rpID: string,
  origin: string,
  { uv = true }: { uv?: boolean } = {},
) {
  pk.counter += 1;
  const authData = concat(
    sha256(rpID),
    new Uint8Array([uv ? 0x05 : 0x01]), // UP | UV, or UP alone
    new Uint8Array([
      pk.counter >>> 24,
      (pk.counter >>> 16) & 0xff,
      (pk.counter >>> 8) & 0xff,
      pk.counter & 0xff,
    ]),
  );
  const clientData = new TextEncoder().encode(
    JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
  );
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pk.keys.privateKey,
      concat(authData, sha256(clientData)),
    ),
  );
  const id = b64url(pk.credentialId);
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(clientData),
      authenticatorData: b64url(authData),
      signature: b64url(derSignature(raw)),
    },
  };
}

/** options → assertion → verify; the token, or throws with the engine's answer. */
export async function passkeyStepUp(
  req: Req,
  cookie: string,
  pk: SoftPasskey,
  action: string,
  origin: string,
): Promise<string> {
  const post = (path: string, body: unknown) =>
    req(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, cookie },
      body: JSON.stringify(body),
    });
  const o = await post('/api/auth/step-up/options', { action });
  if (!o.ok) throw new Error(`step-up options: ${o.status} ${await o.text()}`);
  const { options } = (await o.json()) as { options: { challenge: string; rpId: string } };
  const response = await softAssertion(pk, options.challenge, options.rpId, origin);
  const v = await post('/api/auth/step-up/verify', { action, response });
  if (!v.ok) throw new Error(`step-up verify: ${v.status} ${await v.text()}`);
  return ((await v.json()) as { token: string }).token;
}

/** The current RFC 6238 code for an `otpauth://` URI's secret; `offset` in 30 s steps. */
export function totpCode(totpURI: string, offset = 0): string {
  const secret = new URL(totpURI).searchParams.get('secret') ?? '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * Enable and confirm TOTP through Better Auth. Confirming replaces the session,
 * so the new cookie comes back with the URI.
 */
export async function enrollTotp(
  req: Req,
  cookie: string,
  password: string,
): Promise<{ cookie: string; totpURI: string }> {
  const en = await req('/api/auth/two-factor/enable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ password }),
  });
  if (!en.ok) throw new Error(`two-factor enable: ${en.status} ${await en.text()}`);
  const { totpURI } = (await en.json()) as { totpURI: string };
  const v = await req('/api/auth/two-factor/verify-totp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ code: totpCode(totpURI) }),
  });
  if (!v.ok) throw new Error(`two-factor verify: ${v.status} ${await v.text()}`);
  return { cookie: cookieOf(v) || cookie, totpURI };
}

/**
 * The step-up action an extension mutation names (extension-marketplace-routes.ts),
 * or null for a request that needs none. Mirrored here, not imported: a drift
 * shows up as a 403 in every suite that installs something.
 */
export function stepUpActionFor(method: string, path: string): string | null {
  if (method === 'GET' || method === 'HEAD') return null;
  if (path === '/api/admin/license/rotate') return 'extension.license-rotate';
  if (!path.startsWith('/api/marketplace/')) return null;
  const rest = decodeURIComponent(path.slice('/api/marketplace/'.length));
  if (rest === 'enable-all') return 'extension.enable-all';
  if (rest.startsWith('license/')) {
    return `extension.${method === 'DELETE' ? 'license-delete' : 'license'}:${rest.slice(8)}`;
  }
  const i = rest.lastIndexOf('/');
  const verb = rest.slice(i + 1);
  return verb === 'activate' || verb === 'deactivate'
    ? null
    : `extension.${verb}:${rest.slice(0, i)}`;
}

/**
 * A soft passkey kept in `file` so a second process can step up as the same
 * account: a first factor is enrolled with the password, any later one needs a
 * step-up, so two probes against one engine cannot each enroll their own.
 */
async function savePasskey(file: string, pk: SoftPasskey): Promise<void> {
  await Bun.write(
    file,
    JSON.stringify({
      id: b64url(pk.credentialId),
      counter: pk.counter,
      privateKey: await crypto.subtle.exportKey('jwk', pk.keys.privateKey),
      publicKey: await crypto.subtle.exportKey('jwk', pk.keys.publicKey),
    }),
  );
}

async function loadPasskey(file: string): Promise<SoftPasskey | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  const s = (await f.json()) as {
    id: string;
    counter: number;
    privateKey: JsonWebKey;
    publicKey: JsonWebKey;
  };
  const alg = { name: 'ECDSA', namedCurve: 'P-256' };
  return {
    credentialId: new Uint8Array(Buffer.from(s.id, 'base64url')),
    counter: s.counter,
    keys: {
      privateKey: await crypto.subtle.importKey('jwk', s.privateKey, alg, true, ['sign']),
      publicKey: await crypto.subtle.importKey('jwk', s.publicKey, alg, true, ['verify']),
    },
  };
}

/**
 * Enroll a soft passkey as the session's first factor (behind `password`) and
 * return a fetch on `baseUrl` that steps up each extension mutation it sends.
 * For an out-of-process engine whose BETTER_AUTH_URL is `origin`. The caller's
 * own headers (its cookie) go through as given. With `keyFile`, a passkey
 * already saved there is reused instead of enrolled, and the one enrolled is
 * saved there (with its counter after every step-up).
 */
export async function steppedUpFetch(
  baseUrl: string,
  cookie: string,
  password: string,
  origin = baseUrl,
  keyFile?: string,
): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const req = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
  let pk = keyFile ? await loadPasskey(keyFile) : null;
  if (!pk) {
    pk = await newSoftPasskey();
    const reg = await registerSoftPasskey(req, cookie, pk, origin, { password });
    if (!reg.ok)
      throw new Error(`passkey enrollment on ${baseUrl}: ${reg.status} ${await reg.text()}`);
    if (keyFile) await savePasskey(keyFile, pk);
  }
  const key = pk;
  return async (path, init = {}) => {
    const action = stepUpActionFor(init.method ?? 'GET', new URL(path, baseUrl).pathname);
    if (!action) return req(path, init);
    const headers = new Headers(init.headers);
    headers.set('X-Zveltio-Step-Up', await passkeyStepUp(req, cookie, key, action, origin));
    if (keyFile) await savePasskey(keyFile, key);
    return req(path, { ...init, headers });
  };
}
