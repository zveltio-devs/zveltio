/**
 * Unified error envelope (H-13) — the SDK is the contract source of truth for
 * error shapes, exactly as it is for `ZveltioExtension`.
 *
 * Every non-2xx response from the engine carries an RFC 9457 `problem+json`
 * body: the standard fields (`type`, `title`, `status`, `detail`, `instance`)
 * plus two Zveltio extensions:
 *   - `code`    — a STABLE machine-readable string (e.g. `tenant.membership_required`)
 *                 that clients can switch on without parsing prose.
 *   - `traceId` — correlates with server logs / the W3C trace, for support.
 *
 * The engine mirrors this shape (it can't import the SDK root at build time);
 * keep the two in sync — this file is the canonical definition.
 */

/** RFC 9457 problem-details object + Zveltio `code`/`traceId` extensions. */
export interface ProblemDetails {
  /** URI reference identifying the problem type. `about:blank` when the HTTP
   * status is the only semantics. */
  type: string;
  /** Short, human-readable summary — stable for a given `code`/status. */
  title: string;
  /** HTTP status code, duplicated in the body per RFC 9457. */
  status: number;
  /** Human-readable explanation specific to this occurrence. */
  detail?: string;
  /** URI reference for this specific occurrence — the request path. */
  instance?: string;
  /** Stable machine-readable error code, e.g. `tenant.membership_required`. */
  code: string;
  /** Correlation id for server logs / distributed trace. */
  traceId?: string;
  /** Optional structured details (e.g. per-field validation errors). */
  errors?: unknown;
}

/** MIME type the engine sets on every error response. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * Typed error thrown by the SDK client for any non-2xx response. Carries the
 * parsed envelope; tolerant of legacy `{ error }` shapes during the beta.
 */
export class ZveltioApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly type: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly traceId?: string;
  readonly errors?: unknown;
  /** The full parsed problem object. */
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail || problem.title || `HTTP ${problem.status}`);
    this.name = 'ZveltioApiError';
    this.problem = problem;
    this.code = problem.code;
    this.status = problem.status;
    this.title = problem.title;
    this.type = problem.type;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.traceId = problem.traceId;
    this.errors = problem.errors;
  }

  /** Parse a failed `fetch` Response into a typed error (tolerant fallback). */
  static async fromResponse(res: Response): Promise<ZveltioApiError> {
    const text = await res.text().catch(() => '');
    return ZveltioApiError.fromParts(res.status, text, res.headers.get('content-type'), res.url);
  }

  /** Build from raw parts — handles problem+json, legacy `{ error }`, or prose. */
  static fromParts(
    status: number,
    bodyText: string,
    contentType?: string | null,
    url?: string,
  ): ZveltioApiError {
    const fallbackTitle = statusTitle(status);
    let parsed: Record<string, unknown> | null = null;
    if (bodyText && (contentType?.includes('json') ?? bodyText.trimStart().startsWith('{'))) {
      try {
        parsed = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    if (parsed && typeof parsed.code === 'string' && typeof parsed.title === 'string') {
      // Already an envelope.
      return new ZveltioApiError({ ...(parsed as unknown as ProblemDetails), status });
    }

    // Legacy shapes: { error: "msg" } | { message: "msg" } | { error: {...} }.
    const legacyDetail =
      (typeof parsed?.error === 'string' && parsed.error) ||
      (typeof parsed?.message === 'string' && parsed.message) ||
      (bodyText && !parsed ? bodyText.slice(0, 500) : '') ||
      undefined;
    const legacyErrors =
      parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed?.errors;

    return new ZveltioApiError({
      type: 'about:blank',
      title: fallbackTitle,
      status,
      code: defaultCode(status),
      detail: legacyDetail,
      instance: url,
      errors: legacyErrors,
    });
  }
}

function statusTitle(status: number): string {
  return STATUS_TITLES[status] ?? (status >= 500 ? 'Server Error' : 'Request Error');
}

function defaultCode(status: number): string {
  return DEFAULT_CODES[status] ?? (status >= 500 ? 'internal_error' : 'request_error');
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
