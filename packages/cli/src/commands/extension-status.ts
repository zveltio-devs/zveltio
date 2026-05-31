/**
 * `zveltio extension status <name>` — show marketplace submission status
 * for an extension. Hits the registry's public listing endpoint and
 * the per-extension detail. No auth required (status is public info).
 */

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

export interface ExtensionStatusOptions {
  registryUrl?: string;
}

export async function extensionStatusCommand(
  name: string,
  opts: ExtensionStatusOptions = {},
): Promise<void> {
  const registryUrl = (
    opts.registryUrl ??
    process.env.ZVELTIO_REGISTRY_URL ??
    'https://registry.zveltio.com'
  ).replace(/\/$/, '');

  console.log(`\n${c.bold('Extension status')}\n`);
  console.log(`  Name:      ${c.bold(name)}`);
  console.log(`  Registry:  ${c.dim(registryUrl)}\n`);

  // Public list returns approved extensions only. If our submission is
  // there → status='published'. If not, fall back to the developer
  // detail endpoint which returns everything the calling user owns.
  const listRes = await fetch(`${registryUrl}/api/extensions/list`).catch(() => null);
  if (listRes?.ok) {
    const body = (await listRes.json()) as {
      extensions: Array<{ name: string; version: string; status?: string }>;
    };
    const found = body.extensions.find((e) => e.name === name);
    if (found) {
      console.log(`  Status:    ${c.green('published')} (v${found.version})`);
      console.log(`  ${c.dim('Live in marketplace. Engines can install + enable it.')}`);
      console.log('');
      return;
    }
  }

  // Not in public list — try the dev detail endpoint (returns pending/
  // rejected/taken_down too if the caller owns it). No auth attempted
  // here; the dev endpoint returns 401 if unauth which we map to "we
  // can't see it from here, sign in to the registry to inspect".
  const detailRes = await fetch(
    `${registryUrl}/api/dev/extensions/by-name/${encodeURIComponent(name)}`,
  ).catch(() => null);
  if (detailRes?.ok) {
    const body = (await detailRes.json()) as {
      status: string;
      version: string;
      rejection_reason?: string | null;
      taken_down_reason?: string | null;
      created_at: string;
    };
    const statusColor =
      body.status === 'published' ? c.green : body.status === 'pending' ? c.yellow : c.red;
    console.log(`  Status:    ${statusColor(body.status)} (v${body.version})`);
    console.log(`  Submitted: ${c.dim(body.created_at)}`);
    if (body.rejection_reason) {
      console.log(`  ${c.red('Rejection:')} ${body.rejection_reason}`);
    }
    if (body.taken_down_reason) {
      console.log(`  ${c.red('Takedown:')}  ${body.taken_down_reason}`);
    }
    switch (body.status) {
      case 'pending':
        console.log(c.dim('  Awaiting marketplace admin review.'));
        break;
      case 'published':
        console.log(c.dim('  Live in marketplace.'));
        break;
      case 'rejected':
        console.log(c.dim('  Address the reason above and re-submit.'));
        break;
      case 'taken_down':
        console.log(c.dim('  Removed by admin. Contact support to dispute.'));
        break;
    }
    console.log('');
    return;
  }

  console.log(c.yellow(`  ⚠ Extension "${name}" not found in the marketplace.`));
  console.log(
    c.dim(
      '  - If you just submitted, the registry may take a moment to index.\n' +
        '  - If you publish under a developer account, sign in to the registry web UI to see pending/rejected submissions.\n' +
        '  - First-party / bundled extensions are not surfaced by this command — they ship with the engine binary directly.',
    ),
  );
  console.log('');
}
