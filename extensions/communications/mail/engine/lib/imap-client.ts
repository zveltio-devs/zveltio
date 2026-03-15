/**
 * IMAP/SMTP client wrapper for Zveltio Mail.
 *
 * imapflow, mailparser, nodemailer are auto-installed by the extension loader
 * via peerDependencies in manifest.json — no manual bun add needed.
 */

// @ts-ignore — installed at runtime by extension-loader before this module loads
import { ImapFlow } from 'imapflow';
// @ts-ignore — installed at runtime by extension-loader before this module loads
import { simpleParser } from 'mailparser';
// @ts-ignore — installed at runtime by extension-loader before this module loads
import nodemailer from 'nodemailer';

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

export interface MailAccountConfig {
  id: string;
  email_address: string;
  display_name?: string | null;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  imap_user: string;
  imap_password: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user?: string | null;
  smtp_password?: string | null;
}

/**
 * Syncs a mail account: discovers folders, fetches new messages since last UID.
 */
export async function syncImapAccount(
  db: Database,
  account: MailAccountConfig,
): Promise<{ synced: number; errors: string[] }> {
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_secure,
    auth: { user: account.imap_user, pass: account.imap_password },
    logger: false,
  });

  const results = { synced: 0, errors: [] as string[] };

  try {
    await client.connect();

    // Discover and upsert folders
    const folders = await client.list();
    for (const folder of folders) {
      const folderType = detectFolderType(folder.path, folder.specialUse);
      await sql`
        INSERT INTO zv_mail_folders (account_id, name, path, type)
        VALUES (${account.id}, ${folder.name}, ${folder.path}, ${folderType})
        ON CONFLICT (account_id, path) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type
      `.execute(db);
    }

    // Sync inbox, sent, drafts
    const foldersToSync = await sql<{ id: string; path: string; last_uid: number }>`
      SELECT id, path, last_uid FROM zv_mail_folders
      WHERE account_id = ${account.id} AND type IN ('inbox', 'sent', 'drafts')
    `.execute(db);

    for (const folder of foldersToSync.rows) {
      try {
        const lock = await client.getMailboxLock(folder.path);
        try {
          const since = folder.last_uid > 0 ? `${folder.last_uid + 1}:*` : '1:50';

          for await (const msg of client.fetch(since, {
            uid: true,
            envelope: true,
            bodyStructure: true,
            flags: true,
          })) {
            if (msg.uid <= folder.last_uid) continue;

            const parsed = parseEnvelope(msg);

            await sql`
              INSERT INTO zv_mail_messages (
                account_id, folder_id, message_id, uid, thread_id,
                from_address, from_name, to_addresses, cc_addresses,
                subject, snippet, is_read, has_attachments, sent_at, raw_headers
              ) VALUES (
                ${account.id}, ${folder.id}, ${parsed.messageId}, ${msg.uid}, ${parsed.threadId},
                ${parsed.from.address}, ${parsed.from.name ?? null},
                ${JSON.stringify(parsed.to)}::jsonb, ${JSON.stringify(parsed.cc)}::jsonb,
                ${parsed.subject}, ${(parsed.subject ?? '').slice(0, 200)},
                ${msg.flags?.has('\\Seen') ?? false}, ${parsed.hasAttachments},
                ${parsed.sentAt?.toISOString() ?? null}, ${JSON.stringify(parsed.headers)}::jsonb
              )
              ON CONFLICT DO NOTHING
            `.execute(db);

            results.synced++;
          }

          // Update last_uid and counts from mailbox status
          const status = client.mailbox;
          if (status?.uidNext) {
            await sql`
              UPDATE zv_mail_folders
              SET last_uid = ${(status.uidNext as number) - 1},
                  unread_count = ${(status as any).unseen ?? 0},
                  total_count = ${(status as any).exists ?? 0}
              WHERE id = ${folder.id}
            `.execute(db);
          }
        } finally {
          lock.release();
        }
      } catch (err: any) {
        results.errors.push(`${folder.path}: ${err.message}`);
      }
    }

    await sql`
      UPDATE zv_mail_accounts SET last_sync_at = NOW(), sync_error = NULL WHERE id = ${account.id}
    `.execute(db);

  } catch (err: any) {
    await sql`
      UPDATE zv_mail_accounts SET sync_error = ${err.message} WHERE id = ${account.id}
    `.execute(db);
    results.errors.push(`Connection: ${err.message}`);
  } finally {
    await client.logout().catch(() => { /* ignore */ });
  }

  return results;
}

/**
 * Fetches the full body (text + HTML) of a message on-demand via IMAP.
 */
export async function fetchMessageBody(
  account: MailAccountConfig,
  folderPath: string,
  uid: number,
): Promise<{ bodyText: string | null; bodyHtml: string | null }> {
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_secure,
    auth: { user: account.imap_user, pass: account.imap_password },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(folderPath);
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg?.source) return { bodyText: null, bodyHtml: null };

      const parsed = await simpleParser(msg.source);
      return { bodyText: parsed.text || null, bodyHtml: parsed.html || null };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => { /* ignore */ });
  }
}

/**
 * Sends an email via SMTP using nodemailer.
 */
export async function sendMail(
  account: MailAccountConfig,
  to: string[],
  subject: string,
  bodyHtml: string,
  bodyText?: string,
  cc?: string[],
  bcc?: string[],
  replyTo?: string,
  inReplyTo?: string,
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>,
): Promise<{ messageId: string }> {
  const transport = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_secure,
    auth: {
      user: account.smtp_user || account.imap_user,
      pass: account.smtp_password || account.imap_password,
    },
  });

  const result = await transport.sendMail({
    from: account.display_name
      ? `"${account.display_name}" <${account.email_address}>`
      : account.email_address,
    to: to.join(', '),
    cc: cc?.join(', '),
    bcc: bcc?.join(', '),
    subject,
    text: bodyText || '',
    html: bodyHtml,
    replyTo,
    inReplyTo,
    attachments: attachments?.map(a => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });

  return { messageId: result.messageId };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function detectFolderType(path: string, specialUse?: string): string {
  if (specialUse === '\\Inbox' || path.toUpperCase() === 'INBOX') return 'inbox';
  if (specialUse === '\\Sent' || /sent/i.test(path)) return 'sent';
  if (specialUse === '\\Drafts' || /draft/i.test(path)) return 'drafts';
  if (specialUse === '\\Trash' || /trash|deleted/i.test(path)) return 'trash';
  if (specialUse === '\\Junk' || /spam|junk/i.test(path)) return 'spam';
  if (specialUse === '\\Archive' || /archive/i.test(path)) return 'archive';
  return 'other';
}

function parseEnvelope(msg: any): {
  messageId: string | null;
  from: { address: string; name?: string };
  to: Array<{ address: string; name?: string }>;
  cc: Array<{ address: string; name?: string }>;
  subject: string | null;
  sentAt: Date | null;
  hasAttachments: boolean;
  threadId: string | null;
  headers: Record<string, string>;
} {
  const env = msg.envelope || {};
  return {
    messageId: env.messageId || null,
    from: { address: env.from?.[0]?.address || 'unknown', name: env.from?.[0]?.name },
    to: (env.to || []).map((a: any) => ({ address: a.address, name: a.name })),
    cc: (env.cc || []).map((a: any) => ({ address: a.address, name: a.name })),
    subject: env.subject || null,
    sentAt: env.date ? new Date(env.date) : null,
    hasAttachments: !!(msg.bodyStructure?.childNodes?.some((n: any) => n.disposition === 'attachment')),
    threadId: env.inReplyTo || env.messageId || null,
    headers: msg.headers || {},
  };
}
