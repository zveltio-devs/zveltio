/**
 * zveltio extensions enable|disable|update <name> [--url <engine-url>] [--totp <code>]
 *
 * Marketplace mutations as the signed-in user (`zveltio login`), each confirmed
 * with an authenticator code (ADR 0011).
 */
import { engineFetch, errorOf } from '../lib/engine-session.js';

type Verb = 'enable' | 'disable' | 'update';

export async function extensionMutationCommand(
  verb: Verb,
  name: string,
  opts: { url?: string; totp?: string },
) {
  const url = opts.url || process.env.ENGINE_URL || 'http://localhost:3000';
  let body: Record<string, unknown>;
  try {
    const res = await engineFetch(
      { url, totp: opts.totp },
      `/api/marketplace/${encodeURIComponent(name)}/${verb}`,
      { method: 'POST' },
      `extension.${verb}:${name}`,
    );
    if (!res.ok) throw new Error(await errorOf(res));
    body = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    console.error(`❌ ${verb} ${name} failed: ${(e as Error).message}`);
    process.exit(1);
  }

  if (verb === 'disable') {
    console.log(`${name} disabled.`);
  } else if (verb === 'enable') {
    console.log(
      body.hot_loaded ? `${name} is now active.` : `${name} will be active after restart.`,
    );
  } else if (!body.updated) {
    console.log(`${name} is already at ${body.version}.`);
  } else {
    console.log(`${name} updated ${body.from ?? '?'} → ${body.version}.`);
  }
}
