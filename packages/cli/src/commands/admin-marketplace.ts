/**
 * `zveltio admin marketplace` — registry review-queue commands.
 *
 * Hits the registry admin endpoints (`/api/admin/pending`,
 * `/api/admin/approve/:id`, `/api/admin/reject/:id`,
 * `/api/admin/takedown/:id`). Requires the admin session cookie
 * — for now the admin signs into the registry web UI and exports
 * the cookie via `--cookie` flag or `ZVELTIO_ADMIN_COOKIE` env var.
 *
 * Usage:
 *   $ zveltio admin marketplace pending
 *   $ zveltio admin marketplace approve <name-or-id> [--note "..."]
 *   $ zveltio admin marketplace reject <name-or-id> --reason "..."
 *   $ zveltio admin marketplace takedown <name-or-id> --reason "..."
 *   $ zveltio admin marketplace publishers
 *   $ zveltio admin marketplace enroll-publisher --name "..." --email "..." --key-id "..." --key-file ./pub.jwk [--tier community]
 */

import { readFileSync } from 'node:fs';

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

export interface AdminMarketplaceOptions {
  registryUrl?: string;
  cookie?: string;
  reason?: string;
  note?: string;
  name?: string;
  email?: string;
  keyId?: string;
  keyFile?: string;
  tier?: 'first-party' | 'verified' | 'community';
  notes?: string;
}

function getRegistryUrl(opts: AdminMarketplaceOptions): string {
  return opts.registryUrl ?? process.env.ZVELTIO_REGISTRY_URL ?? 'https://registry.zveltio.com';
}

function getCookie(opts: AdminMarketplaceOptions): string {
  const cookie = opts.cookie ?? process.env.ZVELTIO_ADMIN_COOKIE;
  if (!cookie) {
    console.error(
      c.red(
        'No admin session cookie. Sign in to the registry web UI and pass --cookie or set ZVELTIO_ADMIN_COOKIE.',
      ),
    );
    process.exit(1);
  }
  return cookie;
}

async function adminFetch(
  opts: AdminMarketplaceOptions,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${getRegistryUrl(opts).replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Cookie: getCookie(opts),
    },
  });
}

/** Resolve a name OR id to an extension id by hitting the public list. */
async function resolveExtensionId(
  opts: AdminMarketplaceOptions,
  nameOrId: string,
): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return nameOrId;
  // Try by-name on the public list (includes pending via admin view)
  const res = await adminFetch(opts, '/api/admin/pending');
  if (!res.ok) {
    throw new Error(`Could not list pending to resolve name: ${res.status}`);
  }
  const body = (await res.json()) as { pending: Array<{ id: string; name: string }> };
  const found = body.pending.find((e) => e.name === nameOrId);
  if (!found) {
    throw new Error(
      `No pending extension named "${nameOrId}". Use the id directly if it's already approved.`,
    );
  }
  return found.id;
}

export async function adminMarketplacePending(opts: AdminMarketplaceOptions): Promise<void> {
  const res = await adminFetch(opts, '/api/admin/pending');
  if (!res.ok) {
    console.error(c.red(`Registry returned ${res.status}: ${await res.text()}`));
    process.exit(1);
  }
  const body = (await res.json()) as {
    pending: Array<{
      id: string;
      name: string;
      version: string;
      category: string;
      created_at: string;
      publisher_email: string;
      publisher_name: string | null;
    }>;
    count: number;
  };
  console.log(`\n${c.bold('Pending submissions:')} ${body.count}\n`);
  if (body.count === 0) {
    console.log(c.dim('  (review queue empty)'));
    return;
  }
  for (const e of body.pending) {
    console.log(`  ${c.bold(e.name)} v${e.version}  ${c.dim(`(${e.category})`)}`);
    console.log(`    id:        ${c.dim(e.id)}`);
    console.log(`    publisher: ${e.publisher_name ?? '(no name)'} <${e.publisher_email}>`);
    console.log(`    submitted: ${c.dim(e.created_at)}\n`);
  }
}

export async function adminMarketplaceApprove(
  nameOrId: string,
  opts: AdminMarketplaceOptions,
): Promise<void> {
  const id = await resolveExtensionId(opts, nameOrId);
  const res = await adminFetch(opts, `/api/admin/approve/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: opts.note ?? null }),
  });
  if (!res.ok) {
    console.error(c.red(`Approve failed (${res.status}): ${await res.text()}`));
    process.exit(1);
  }
  console.log(c.green(`✓ Approved ${nameOrId}`));
}

export async function adminMarketplaceReject(
  nameOrId: string,
  opts: AdminMarketplaceOptions,
): Promise<void> {
  if (!opts.reason) {
    console.error(c.red('--reason is required for reject'));
    process.exit(1);
  }
  const id = await resolveExtensionId(opts, nameOrId);
  const res = await adminFetch(opts, `/api/admin/reject/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: opts.reason }),
  });
  if (!res.ok) {
    console.error(c.red(`Reject failed (${res.status}): ${await res.text()}`));
    process.exit(1);
  }
  console.log(c.green(`✓ Rejected ${nameOrId}`));
}

export async function adminMarketplaceTakedown(
  nameOrId: string,
  opts: AdminMarketplaceOptions,
): Promise<void> {
  if (!opts.reason) {
    console.error(c.red('--reason is required for takedown'));
    process.exit(1);
  }
  // takedown can't use the pending-list lookup (extension is published).
  // Caller must pass the id directly for now.
  if (!/^[0-9a-f-]{36}$/i.test(nameOrId)) {
    console.error(
      c.red(
        `Takedown requires the extension id (UUID), not the name. Look it up at ${getRegistryUrl(opts)}/extensions/${encodeURIComponent(nameOrId)}.`,
      ),
    );
    process.exit(1);
  }
  const res = await adminFetch(opts, `/api/admin/takedown/${nameOrId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: opts.reason }),
  });
  if (!res.ok) {
    console.error(c.red(`Takedown failed (${res.status}): ${await res.text()}`));
    process.exit(1);
  }
  console.log(c.green(`✓ Taken down ${nameOrId}`));
}

export async function adminMarketplacePublishers(opts: AdminMarketplaceOptions): Promise<void> {
  const res = await adminFetch(opts, '/api/admin/publishers');
  if (!res.ok) {
    console.error(c.red(`Registry returned ${res.status}: ${await res.text()}`));
    process.exit(1);
  }
  const body = (await res.json()) as {
    publishers: Array<{
      id: string;
      publisher_name: string;
      contact_email: string;
      tier: string;
      status: string;
      key_id: string;
      enrolled_at: string;
    }>;
    count: number;
  };
  console.log(`\n${c.bold('Enrolled publishers:')} ${body.count}\n`);
  if (body.count === 0) {
    console.log(c.dim('  (no publishers enrolled — only first-party SYNC_TOKEN flow active)'));
    return;
  }
  for (const p of body.publishers) {
    const statusColor =
      p.status === 'active' ? c.green : p.status === 'suspended' ? c.yellow : c.red;
    console.log(
      `  ${c.bold(p.publisher_name)} ${c.dim(`(${p.contact_email})`)}  [${statusColor(p.status)}]`,
    );
    console.log(`    tier:        ${p.tier}`);
    console.log(`    key_id:      ${c.dim(p.key_id)}`);
    console.log(`    id:          ${c.dim(p.id)}`);
    console.log(`    enrolled:    ${c.dim(p.enrolled_at)}\n`);
  }
}

export async function adminMarketplaceEnrollPublisher(
  opts: AdminMarketplaceOptions,
): Promise<void> {
  if (!opts.name || !opts.email || !opts.keyId || !opts.keyFile) {
    console.error(c.red('--name, --email, --key-id, --key-file required for enroll-publisher'));
    process.exit(1);
  }
  let keyJwk: string;
  try {
    keyJwk = readFileSync(opts.keyFile, 'utf8').trim();
  } catch (err) {
    console.error(c.red(`Could not read key file ${opts.keyFile}: ${(err as Error).message}`));
    process.exit(1);
  }
  try {
    JSON.parse(keyJwk);
  } catch {
    console.error(c.red(`Key file ${opts.keyFile} is not valid JSON`));
    process.exit(1);
  }

  const res = await adminFetch(opts, '/api/admin/publishers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publisher_name: opts.name,
      contact_email: opts.email,
      public_key_jwk: keyJwk,
      key_id: opts.keyId,
      tier: opts.tier ?? 'community',
      notes: opts.notes ?? null,
    }),
  });
  if (!res.ok) {
    console.error(c.red(`Enroll failed (${res.status}): ${await res.text()}`));
    process.exit(1);
  }
  const body = (await res.json()) as { id: string };
  console.log(c.green(`✓ Publisher enrolled — id ${body.id}`));
}
