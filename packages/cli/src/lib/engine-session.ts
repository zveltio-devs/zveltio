/**
 * The CLI's session on an engine (ADR 0011).
 *
 * `zveltio login` signs in as the user, with the TOTP code when the account has
 * one, and keeps the bearer session the engine issues to a cookie-less caller —
 * never the password. Sessions live in `$XDG_CONFIG_HOME/zveltio/credentials.json`
 * (mode 0600), one per engine origin.
 *
 * A session alone installs nothing: each marketplace mutation asks for a fresh
 * TOTP code and trades it at `/api/auth/step-up/verify` for a token bound to that
 * session and that one action. A passkey cannot be used from a terminal, so an
 * account that steps up with a passkey only is sent to the Console.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promptHidden } from './prompt.js';

export interface EngineTarget {
  url: string;
  /** A TOTP code given on the command line; used for the first step-up only. */
  totp?: string;
}

export function credentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'zveltio', 'credentials.json');
}

function readAll(): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(credentialsPath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  // A file that does not parse is refused, not replaced: rewriting it would drop
  // every other engine's session.
  try {
    return JSON.parse(text) as Record<string, string>;
  } catch {
    throw new Error(
      `${credentialsPath()} is not valid JSON. Fix or delete it, then sign in again.`,
    );
  }
}

function writeAll(all: Record<string, string>): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // A new file, 0600 from creation, renamed over the old one: the token is never
  // in a file with a wider mode, whatever mode the old one had.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

/** The engine's origin. A session goes in clear over `http:` only to this machine. */
const originOf = (url: string): string => {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error(
      `Refusing ${u.origin}: use https:// for an engine that is not on this machine.`,
    );
  }
  return u.origin;
};

export function sessionFor(url: string): string | null {
  return readAll()[originOf(url)] ?? null;
}

export function saveSession(url: string, token: string): void {
  writeAll({ ...readAll(), [originOf(url)]: token });
}

export function forgetSession(url: string): void {
  const all = readAll();
  delete all[originOf(url)];
  writeAll(all);
}

/** The engine's own sentence for a refusal, else the status. */
export async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const text = body.error ?? body.message ?? body.detail;
  return typeof text === 'string' ? text : `HTTP ${res.status}`;
}

/**
 * Sign in and return the bearer session. `askCode` is called only when the
 * account has TOTP (Better Auth answers `twoFactorRedirect`).
 */
export async function signIn(
  url: string,
  email: string,
  password: string,
  askCode: () => Promise<string>,
): Promise<string> {
  const origin = originOf(url);
  const json = { 'Content-Type': 'application/json', Origin: origin };
  const res = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Sign-in failed: ${await errorOf(res)}`);
  let token = res.headers.get('set-auth-token');
  const body = (await res.json().catch(() => ({}))) as { twoFactorRedirect?: boolean };
  if (body.twoFactorRedirect) {
    // The second step is tied to the first by Better Auth's two-factor cookie.
    // The emptied session cookies it also sets stay behind: sent back, they mark
    // the caller as a cookie client and the engine issues no bearer session.
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .filter((c) => !c.endsWith('='))
      .join('; ');
    const v = await fetch(`${origin}/api/auth/two-factor/verify-totp`, {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ code: (await askCode()).trim() }),
    });
    if (!v.ok) throw new Error(`Sign-in failed: ${await errorOf(v)}`);
    token = v.headers.get('set-auth-token');
  }
  if (!token) throw new Error(`${origin} issued no bearer session.`);
  return token;
}

/**
 * Open `url` in the default browser; the printed link is the fallback.
 * `ZVELTIO_NO_BROWSER=1` only prints it (a server, a test).
 */
function openBrowser(url: string): void {
  if (process.env.ZVELTIO_NO_BROWSER) return;
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // No opener: the person follows the printed link.
  }
}

/**
 * Have the person confirm in the Console (ADR 0011 amendment 1): a sign-in, or
 * one step-up for the session `bearer`. Returns the session or step-up token.
 */
export async function confirmInBrowser(
  url: string,
  request: { kind: 'login' } | { kind: 'step-up'; action: string },
  bearer?: string,
): Promise<string> {
  const origin = originOf(url);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: origin };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(`${origin}/api/auth/cli/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });
  if (res.status === 401) throw notSignedIn(origin);
  if (!res.ok) throw new Error(await errorOf(res));
  const started = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_path: string;
    expires_in: number;
    interval: number;
  };
  const link = `${origin}${started.verification_path}?code=${started.user_code}`;
  const what = request.kind === 'login' ? 'sign-in' : request.action;
  console.log(`\n  Confirm ${what} in your browser. Code: ${started.user_code}`);
  console.log(`  ${link}\n`);
  openBrowser(link);

  const deadline = Date.now() + started.expires_in * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(started.interval * 1000);
    const p = await fetch(`${origin}/api/auth/cli/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ device_code: started.device_code }),
    }).catch(() => null);
    if (!p) continue; // a dropped poll is retried until the request expires
    const body = (await p.json().catch(() => ({}))) as { status?: string; token?: string };
    if (body.status === 'approved' && body.token) return body.token;
    if (body.status === 'expired' || p.status === 410)
      throw new Error('The request was denied or has expired.');
  }
  throw new Error('The request has expired.');
}

const notSignedIn = (origin: string) =>
  new Error(`Not signed in to ${origin}. Run: zveltio login --url ${origin}`);

/** Trade a TOTP code for a step-up token for `action`. */
async function stepUp(target: EngineTarget, token: string, action: string): Promise<string> {
  const origin = originOf(target.url);
  const post = (path: string, body: unknown) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

  const options = await post('/api/auth/step-up/options', { action });
  if (options.status === 401) throw notSignedIn(origin);
  if (!options.ok) throw new Error(await errorOf(options));
  const { method, totp } = (await options.json()) as { method: string; totp?: boolean };
  // A passkey cannot be used from a terminal: the browser confirms instead.
  if (method !== 'totp' && !totp)
    return confirmInBrowser(origin, { kind: 'step-up', action }, token);

  for (let attempt = 0; attempt < 3; attempt++) {
    const given = target.totp;
    target.totp = undefined; // one code mints one token
    if (given === undefined && !process.stdin.isTTY) {
      throw new Error(
        `An authenticator code is needed for ${action}: pass --totp <code>, or run this in a terminal.`,
      );
    }
    const code = given ?? (await promptHidden(`Authenticator code for ${action}: `));
    const res = await post('/api/auth/step-up/verify', { action, code: code.trim() });
    if (res.ok) return ((await res.json()) as { token: string }).token;
    const why = await errorOf(res);
    // "already used. Wait for the next one" and a mistyped code are worth another try.
    if (!process.stdin.isTTY || res.status === 429) throw new Error(why);
    console.error(`  ${why}`);
  }
  throw new Error('Step-up failed.');
}

/**
 * `fetch` against the engine as the signed-in user. With `action`, the request
 * carries a step-up token for it.
 */
export async function engineFetch(
  target: EngineTarget,
  path: string,
  init: RequestInit = {},
  action?: string,
): Promise<Response> {
  const origin = originOf(target.url);
  const token = sessionFor(origin);
  if (!token) throw notSignedIn(origin);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (action) headers.set('X-Zveltio-Step-Up', await stepUp(target, token, action));
  const res = await fetch(`${origin}${path}`, { ...init, headers });
  if (res.status === 401) throw notSignedIn(origin);
  return res;
}
