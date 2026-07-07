/**
 * Unified error envelope (H-13) — engine side.
 *
 * Guarantees every non-2xx response under `/api/*` and `/ext/*` is an RFC 9457
 * `application/problem+json` body, via three hooks wired in index.ts:
 *   - `problemOnError`     — thrown errors / HTTPException → envelope.
 *   - `problemNotFound`    — unmatched API routes → envelope.
 *   - `problemNormalizer()`— scoped middleware that rewraps any non-2xx a route
 *                            returned (legacy `c.json({ error })`, `c.notFound()`)
 *                            into the envelope, inferring a `code` from status.
 *
 * Routes that want a rich, stable `code` throw `problem(code, status, detail)`
 * instead of `c.json({ error }, status)`; everything else is upgraded for free.
 *
 * The `ProblemDetails` shape is the SDK contract (`@zveltio/sdk` → errors.ts);
 * it is mirrored here because the engine can't import the SDK root at build
 * time. Keep the two in sync.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** RFC 9457 problem-details + Zveltio `code`/`traceId` — mirrors the SDK. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  traceId?: string;
  errors?: unknown;
}

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const DEFAULT_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_failed',
  429: 'rate_limited',
  500: 'internal_error',
  501: 'not_implemented',
  502: 'bad_gateway',
  503: 'unavailable',
  504: 'gateway_timeout',
};

const statusTitle = (s: number): string =>
  STATUS_TITLES[s] ?? (s >= 500 ? 'Server Error' : 'Request Error');
const defaultCode = (s: number): string =>
  DEFAULT_CODES[s] ?? (s >= 500 ? 'internal_error' : 'request_error');

/** Extract a correlation id from the W3C traceparent, else mint one. */
function traceIdFrom(c: Context): string {
  const tp = c.req.header('traceparent') ?? c.res.headers.get('traceparent') ?? '';
  const m = /^00-([0-9a-f]{32})-/.exec(tp);
  return m ? m[1] : crypto.randomUUID();
}

/**
 * An HTTPException carrying a stable `code` (+ optional structured `errors`).
 * Thrown by routes via `problem()`; `problemOnError` renders it to the envelope.
 */
export class ProblemException extends HTTPException {
  readonly code: string;
  readonly problemDetail?: string;
  readonly errors?: unknown;
  constructor(code: string, status: number, detail?: string, errors?: unknown) {
    // Store the human detail as the HTTPException message (used if it escapes).
    super(status as ConstructorParameters<typeof HTTPException>[0], { message: detail ?? code });
    this.code = code;
    this.problemDetail = detail;
    this.errors = errors;
  }
}

/**
 * Build a thrown error carrying a stable code. Usage in a route:
 *   `throw problem('tenant.membership_required', 403, 'You are not a member…')`
 */
export function problem(
  code: string,
  status: number,
  detail?: string,
  errors?: unknown,
): ProblemException {
  return new ProblemException(code, status, detail, errors);
}

function toResponse(p: ProblemDetails): Response {
  return new Response(JSON.stringify(p), {
    status: p.status,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE },
  });
}

/** Hono `app.onError` handler — renders thrown errors as problem+json. */
export function problemOnError(err: Error, c: Context): Response {
  const instance = c.req.path;
  const traceId = traceIdFrom(c);

  if (err instanceof ProblemException) {
    return toResponse({
      type: 'about:blank',
      title: statusTitle(err.status),
      status: err.status,
      code: err.code,
      detail: err.problemDetail,
      instance,
      traceId,
      errors: err.errors,
    });
  }

  if (err instanceof HTTPException) {
    return toResponse({
      type: 'about:blank',
      title: statusTitle(err.status),
      status: err.status,
      code: defaultCode(err.status),
      // HTTPException messages are developer-set and safe to surface.
      detail: err.message || undefined,
      instance,
      traceId,
    });
  }

  // Unknown error — never leak internals; log server-side, return generic 500.
  console.error(
    `[problem] unhandled error on ${c.req.method} ${instance} (trace ${traceId}):`,
    err,
  );
  return toResponse({
    type: 'about:blank',
    title: statusTitle(500),
    status: 500,
    code: 'internal_error',
    detail: 'An unexpected error occurred.',
    instance,
    traceId,
  });
}

/** Hono `app.notFound` handler — envelope for unmatched routes. */
export function problemNotFound(c: Context): Response {
  return toResponse({
    type: 'about:blank',
    title: statusTitle(404),
    status: 404,
    code: 'not_found',
    detail: `No route for ${c.req.method} ${c.req.path}.`,
    instance: c.req.path,
    traceId: traceIdFrom(c),
  });
}

/** Map a legacy/plain error body to a ProblemDetails for the given status. */
function normalizeBody(status: number, raw: string, c: Context): ProblemDetails {
  let parsed: Record<string, unknown> | null = null;
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }

  const detail =
    (typeof parsed?.error === 'string' && parsed.error) ||
    (typeof parsed?.message === 'string' && parsed.message) ||
    (typeof parsed?.detail === 'string' && parsed.detail) ||
    (!parsed && raw ? raw.slice(0, 500) : '') ||
    undefined;
  // zValidator emits { success:false, error: ZodError } — surface its issues.
  const zodIssues =
    parsed?.error && typeof parsed.error === 'object'
      ? (parsed.error as { issues?: unknown }).issues
      : undefined;
  const code =
    (typeof parsed?.code === 'string' && parsed.code) ||
    (zodIssues ? 'validation_failed' : defaultCode(status));

  return {
    type: 'about:blank',
    title: statusTitle(status),
    status,
    code,
    detail,
    instance: c.req.path,
    traceId: traceIdFrom(c),
    errors: zodIssues ?? (parsed?.errors as unknown),
  };
}

/**
 * Scoped middleware: after the handler runs, if the response is a non-2xx that
 * is NOT already problem+json, rewrap it into the envelope. Mount on `/api/*`
 * and `/ext/*` so the whole JSON API surface is uniform. Thrown errors bypass
 * this (they hit `problemOnError`); this only upgrades RETURNED responses.
 */
export function problemNormalizer(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const status = c.res.status;
    if (status < 400) return;
    const ct = c.res.headers.get('content-type') ?? '';
    if (ct.includes('application/problem+json')) return; // already an envelope

    const raw = await c.res
      .clone()
      .text()
      .catch(() => '');
    const problemBody = normalizeBody(status, raw, c);

    // Preserve meaningful headers (rate-limit, www-authenticate, traceparent).
    const headers = new Headers(c.res.headers);
    headers.set('content-type', PROBLEM_CONTENT_TYPE);
    headers.delete('content-length'); // body size changed
    c.res = new Response(JSON.stringify(problemBody), { status, headers });
  };
}
