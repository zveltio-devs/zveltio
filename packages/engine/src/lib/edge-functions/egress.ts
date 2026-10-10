/**
 * Egress for edge functions (RFC extension-runner, step 10).
 *
 * A function declares the hosts it may reach in its env var `ZVELTIO_EGRESS`
 * ("api.stripe.com, hooks.slack.com"), beside `ZVELTIO_PUBLIC`: the admin who
 * saves the function writes both, so saving it is the approval. A function that
 * declares it calls `fetch` through the ENGINE: the sandbox writes one
 * `FETCH <json>` line on stdout, the engine performs the request with the
 * shared SSRF guard, held to the list on every redirect hop, and answers one
 * JSON line on the sandbox's stdin. On the runner that line crosses the
 * runner's socket, so the runner itself keeps no network.
 *
 * Matching is exact on the authority: `api.x.com` is that name on the scheme's
 * default port (http 80, https 443), `api.x.com:8443` that port only. No
 * wildcards, no suffixes; an IDN is listed in its `xn--` form, as URL spells it.
 * Only http and https.
 *
 * Nothing in this module may need node_modules: the compose probe runs it from
 * source without them.
 */

import { createSafeFetch } from './safe-fetch.js';

export const EGRESS_ENV = 'ZVELTIO_EGRESS';
/** The line prefix a sandbox's egress request carries on stdout. */
export const FETCH_LINE = 'FETCH ';

export const EGRESS_LIMITS = {
  /** Request bodies; the sandbox refuses larger ones before sending. */
  requestBytes: 1024 * 1024,
  /** Response bodies; the engine stops reading and answers an error past it. */
  responseBytes: 5 * 1024 * 1024,
  /** One FETCH line, base64 body and headers included. Past it the invocation is killed. */
  lineBytes: 2 * 1024 * 1024,
  /** Requests per invocation. */
  requests: 50,
  /** Requests in flight per invocation; the rest wait. */
  inFlight: 6,
};

const ENTRY_RE =
  /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/;

/**
 * The function's declared hosts, or null when it declares none. An empty value
 * is a declaration too: no egress, and the runner by default. Throws on an entry
 * that is not a host, so a mistyped list fails the invocation instead of being
 * read as something wider or narrower than the admin wrote.
 */
export function parseEgress(env: Record<string, string> | null | undefined): string[] | null {
  const raw = env?.[EGRESS_ENV];
  if (raw === undefined || raw === null) return null;
  const entries = String(raw)
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  for (const e of entries) {
    if (!ENTRY_RE.test(e)) {
      throw new Error(
        `${EGRESS_ENV}: "${e}" is not a host — list host names or host:port, no scheme, path or wildcard`,
      );
    }
  }
  return entries;
}

/** Whether `url` is in `list` — exact authority, see the module comment. */
export function egressAllows(list: readonly string[], url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return list.some(
    (e) => (url.port === '' && e === url.hostname) || e === `${url.hostname}:${port}`,
  );
}

/** What the sandbox sends. */
interface EgressRequest {
  id: number;
  url: string;
  method: string;
  headers: [string, string][];
  body: string | null;
}

/** What the engine answers. */
export type EgressAnswer =
  | {
      id: number;
      ok: true;
      status: number;
      statusText: string;
      headers: [string, string][];
      body: string;
    }
  | { id: number; ok: false; error: string };

// The engine sets these for the connection it opens.
const DROPPED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

function parseRequest(line: string): EgressRequest | null {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  const r = m as Partial<EgressRequest>;
  if (!r || typeof r !== 'object' || !Number.isInteger(r.id)) return null;
  const headersOk =
    Array.isArray(r.headers) &&
    r.headers.every(
      (h) => Array.isArray(h) && typeof h[0] === 'string' && typeof h[1] === 'string',
    );
  if (
    typeof r.url !== 'string' ||
    typeof r.method !== 'string' ||
    !/^[A-Za-z]{1,16}$/.test(r.method) ||
    !headersOk ||
    (r.body !== null && typeof r.body !== 'string')
  ) {
    return { id: r.id as number, url: '', method: '', headers: [], body: null };
  }
  return r as EgressRequest;
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`[egress] response exceeds ${cap} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Perform one request for a sandbox, under `list` and the SSRF guard. */
export async function performEgress(
  req: EgressRequest,
  list: readonly string[],
  signal: AbortSignal,
): Promise<EgressAnswer> {
  const { id, url, method, headers, body } = req;
  try {
    if (!method) throw new Error('[egress] malformed request');
    // Resolved per request, so a test that stubs globalThis.fetch stubs the network
    // under the guard and nothing else.
    const guarded = createSafeFetch(
      () => fetch,
      (u) => {
        if (!egressAllows(list, u)) {
          throw new Error(
            list.length
              ? `[egress] ${u.host} is not in this function's ${EGRESS_ENV} (${list.join(', ')})`
              : `[egress] this function declares no egress (${EGRESS_ENV})`,
          );
        }
      },
    );
    const sent = new Headers();
    for (const [k, v] of headers) if (!DROPPED_HEADERS.has(k.toLowerCase())) sent.append(k, v);
    const bytes = body === null ? null : Buffer.from(body, 'base64');
    if (bytes && bytes.byteLength > EGRESS_LIMITS.requestBytes) {
      throw new Error(`[egress] request body exceeds ${EGRESS_LIMITS.requestBytes} bytes`);
    }
    const res = await guarded(url, { method, headers: sent, body: bytes, signal });
    const data = await readCapped(res, EGRESS_LIMITS.responseBytes);
    return {
      id,
      ok: true,
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers],
      body: Buffer.from(data).toString('base64'),
    };
  } catch (err) {
    return { id, ok: false, error: (err as Error).message };
  }
}

/**
 * The engine's end of one invocation's egress channel. `line` takes each
 * `FETCH` line (prefix stripped), `reply` writes an answer line back to the
 * sandbox, `kill` ends the invocation when the sandbox breaks the protocol's
 * bounds. `close` aborts what is still in flight.
 */
export function createEgressBridge(
  list: readonly string[],
  timeoutMs: number,
  reply: (line: string) => void,
  kill: (why: string) => void,
): { line: (json: string) => void; close: () => void } {
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
  let total = 0;
  let active = 0;
  const waiting: (() => void)[] = [];
  const answer = (a: EgressAnswer) => {
    if (!abort.signal.aborted) reply(`${JSON.stringify(a)}\n`);
  };
  return {
    line(json) {
      if (json.length > EGRESS_LIMITS.lineBytes) {
        kill(`egress request exceeds ${EGRESS_LIMITS.lineBytes} bytes`);
        return;
      }
      const req = parseRequest(json);
      if (!req) {
        kill('malformed egress request');
        return;
      }
      if (++total > EGRESS_LIMITS.requests) {
        answer({
          id: req.id,
          ok: false,
          error: `[egress] more than ${EGRESS_LIMITS.requests} requests in one invocation`,
        });
        return;
      }
      void (async () => {
        while (active >= EGRESS_LIMITS.inFlight) await new Promise<void>((r) => waiting.push(r));
        active++;
        try {
          answer(await performEgress(req, list, signal));
        } finally {
          active--;
          waiting.shift()?.();
        }
      })();
    },
    close() {
      abort.abort();
    },
  };
}

/**
 * Split a byte stream into lines, handing each `FETCH` line to `onFetch` as it
 * arrives and keeping the rest. Resolves with the kept text once the stream
 * ends. A partial line longer than `maxLine` goes to `onFetch` as it stands, so
 * the bridge's own bound decides, and is not buffered further.
 */
export async function splitFetchLines(
  stream: ReadableStream<Uint8Array>,
  onFetch: ((json: string) => void) | null,
  maxLine = EGRESS_LIMITS.lineBytes + FETCH_LINE.length,
): Promise<string> {
  const decoder = new TextDecoder();
  const kept: string[] = [];
  let buf = '';
  const take = (line: string) => {
    if (onFetch && line.startsWith(FETCH_LINE)) onFetch(line.slice(FETCH_LINE.length));
    else kept.push(line);
  };
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      take(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
    if (onFetch && buf.length > maxLine && buf.startsWith(FETCH_LINE)) {
      onFetch(buf.slice(FETCH_LINE.length));
      buf = '';
    }
  }
  buf += decoder.decode();
  if (buf) take(buf);
  return kept.join('\n');
}
