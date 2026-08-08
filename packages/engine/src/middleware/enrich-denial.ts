/**
 * Fill in who to ask, for every refusal, from the host.
 *
 * `permissionGate` lives in the SDK and the SDK is inlined into each extension
 * bundle at pack time. So the sentence a person reads when they are refused
 * exists in twenty-eight copies, and improving it means repacking twenty-eight
 * extensions — which is how a message stays bad for years. The same shape as
 * every extension carrying its own Hono.
 *
 * The host is the right place for it. A refusal is the product's contract with
 * the person using it, not an implementation detail of whichever extension
 * happened to be in the way, and the host is also the only party that can look
 * up who holds an administrative role.
 *
 * So the gate says WHAT was refused and this fills in WHAT TO DO. Both shapes
 * are accepted:
 *
 *   - a repacked bundle sends `code: permission_required` with `resource` and
 *     `action` as fields;
 *   - one that has not been repacked sends the old
 *     `Forbidden: missing <resource>:<action> permission`, which is parsed here
 *     so an install gets the better message before every extension is rebuilt.
 *
 * Runs before `problemNormalizer`, which would otherwise flatten these into a
 * generic envelope and lose the fields.
 */
import type { MiddlewareHandler } from 'hono';
import { PROBLEM_CONTENT_TYPE } from '../lib/problem.js';
import { describeDenial } from '../lib/tenancy/index.js';
import type { Database } from '../db/index.js';

/** The legacy sentence, kept parseable so old bundles benefit too. */
const LEGACY = /missing\s+([a-z0-9_\-/]+):([a-z0-9_]+)\s+permission/i;

interface DenialBody {
  code?: string;
  resource?: string;
  action?: string;
  detail?: string;
  error?: string;
  [k: string]: unknown;
}

/** Read the resource and action out of either shape, or null if this is not a permission refusal. */
function subject(body: DenialBody): { resource: string; action: string } | null {
  if (body.code === 'permission_required' && body.resource && body.action) {
    return { resource: String(body.resource), action: String(body.action) };
  }
  const text = String(body.detail ?? body.error ?? '');
  const m = LEGACY.exec(text);
  return m ? { resource: m[1], action: m[2] } : null;
}

export function enrichDenial(db: Database): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status !== 403) return;

    let body: DenialBody;
    try {
      body = (await c.res.clone().json()) as DenialBody;
    } catch {
      return; // not JSON — nothing to improve
    }

    const subj = subject(body);
    if (!subj) return;

    let denial: Awaited<ReturnType<typeof describeDenial>>;
    try {
      denial = await describeDenial(db, subj.resource, subj.action);
    } catch {
      return; // a refusal must never become a 500 for want of a courtesy
    }

    const names = denial.canGrant.map((g) => g.name);
    const what = denial.confidential
      ? `${subj.resource} is confidential`
      : `you do not have access to ${subj.resource}`;
    const who =
      names.length === 0
        ? 'An administrator of this workspace'
        : names.length === 1
          ? names[0]
          : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;

    const headers = new Headers(c.res.headers);
    headers.set('content-type', PROBLEM_CONTENT_TYPE);
    headers.delete('content-length');
    c.res = new Response(
      JSON.stringify({
        ...body,
        // Machine-stable, so callers branch on this and never on the prose.
        code: 'permission_required',
        title: 'Forbidden',
        status: 403,
        detail:
          names.length === 0
            ? `${what}. ${who} can grant it.`
            : `${what}. ${who} can give you access.`,
        resource: subj.resource,
        action: subj.action,
        confidential: denial.confidential,
        // Names, never addresses: the point is "ask Ana", not a directory
        // export for whoever probes a 403.
        can_grant: names.map((name) => ({ name })),
      }),
      { status: 403, headers },
    );
  };
}
