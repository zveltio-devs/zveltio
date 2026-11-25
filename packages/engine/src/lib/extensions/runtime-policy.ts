/**
 * ADR 0062 d3: where an extension's process stays up is the operator's choice,
 * per extension — never the manifest's (RFC v3 l.53-55). Always on, or stopped
 * after an idle timeout and started again by its next call.
 *
 * Kept in `zv_settings` as `ext_runtime:<name>`, beside `ext_license:<name>`:
 * an engine setting about the extension, which the extension itself never reads
 * (its `ctx.db` refuses `zv_settings`). Always on is a latency choice only:
 * every call reaches the extension through the engine, which starts it first.
 */

import type { Database } from '../../db/index.js';

export interface RuntimePolicy {
  alwaysOn: boolean;
  idleTimeoutSeconds: number;
}

export const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;
const MAX_IDLE_TIMEOUT_SECONDS = 7 * 24 * 3600;

/**
 * First-party extensions a person waits on at a till or a desk start always on
 * (owner, 2026-11-25); an operator's setting overrides this either way.
 */
export const ALWAYS_ON_BY_DEFAULT: ReadonlySet<string> = new Set([
  'finance/invoicing',
  'operations/pos',
]);

export function runtimeSettingKey(extName: string): string {
  return `ext_runtime:${extName}`;
}

export function defaultRuntimePolicy(extName: string): RuntimePolicy {
  return {
    alwaysOn: ALWAYS_ON_BY_DEFAULT.has(extName),
    idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
  };
}

/**
 * The operator's fields of a setting body, or why it is refused. Either field
 * may be absent: the other keeps its value.
 */
export function parseRuntimeBody(body: unknown): Partial<RuntimePolicy> | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Body must be { alwaysOn?: boolean, idleTimeoutSeconds?: integer }';
  }
  const { alwaysOn, idleTimeoutSeconds, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return `Unknown fields: ${Object.keys(rest).join(', ')}`;
  if (alwaysOn !== undefined && typeof alwaysOn !== 'boolean') return 'alwaysOn must be a boolean';
  if (
    idleTimeoutSeconds !== undefined &&
    (!Number.isInteger(idleTimeoutSeconds) ||
      (idleTimeoutSeconds as number) < 1 ||
      (idleTimeoutSeconds as number) > MAX_IDLE_TIMEOUT_SECONDS)
  ) {
    return `idleTimeoutSeconds must be an integer from 1 to ${MAX_IDLE_TIMEOUT_SECONDS}`;
  }
  return {
    ...(alwaysOn === undefined ? {} : { alwaysOn }),
    ...(idleTimeoutSeconds === undefined ? {} : { idleTimeoutSeconds: idleTimeoutSeconds as number }),
  };
}

/** A stored value over the defaults; one that does not parse is the defaults. */
export function runtimePolicyOf(extName: string, stored: unknown): RuntimePolicy {
  const parsed = parseRuntimeBody(stored);
  return { ...defaultRuntimePolicy(extName), ...(typeof parsed === 'string' ? {} : parsed) };
}

/** What the operator set for `extName`, over its defaults. Throws when unreadable. */
export async function readRuntimePolicy(db: Database, extName: string): Promise<RuntimePolicy> {
  const row = await db
    .selectFrom('zv_settings')
    .select('value')
    .where('key', '=', runtimeSettingKey(extName))
    .executeTakeFirst();
  return runtimePolicyOf(extName, row?.value);
}

/** As the worker host takes it. */
export function workerRuntime(p: RuntimePolicy): { alwaysOn: boolean; idleTimeoutMs: number } {
  return { alwaysOn: p.alwaysOn, idleTimeoutMs: p.idleTimeoutSeconds * 1000 };
}
