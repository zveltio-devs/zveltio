/**
 * Compose operations: reply, reply-all, forward, drafts, auto-collect contacts.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { sendMail } from './imap-client.js';

// ═══ REPLY / FORWARD CONTEXT ═════════════════════════════════════════════════

/**
 * Builds pre-populated compose state for reply, reply-all, or forward.
 */
export async function buildReplyContext(
  db: Database,
  messageId: string,
  type: 'reply' | 'reply_all' | 'forward',
  userId: string,
): Promise<{
  to: Array<{ address: string; name?: string }>;
  cc: Array<{ address: string; name?: string }>;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  inReplyTo: string | null;
  references: string | null;
  originalMessageId: string;
}> {
  const result = await sql`
    SELECT m.*, a.email_address AS my_email FROM zv_mail_messages m
    INNER JOIN zv_mail_accounts a ON a.id = m.account_id
    WHERE m.id = ${messageId} AND a.user_id = ${userId}
  `.execute(db);

  if (!result.rows[0]) throw new Error('Message not found');
  const m = result.rows[0] as any;

  const prefix = type === 'forward' ? 'Fwd' : 'Re';
  const subject = m.subject?.startsWith(`${prefix}: `) ? m.subject : `${prefix}: ${m.subject || ''}`;

  const sentDate = new Date(m.sent_at || m.received_at).toLocaleString();
  const senderLabel = m.from_name ? `${m.from_name} &lt;${m.from_address}&gt;` : m.from_address;

  const quotedHtml = `
    <br><br>
    <div style="border-left:2px solid #ccc;padding-left:12px;margin-left:4px;color:#555;">
      <p><strong>On ${sentDate}, ${senderLabel} wrote:</strong></p>
      ${m.body_html || `<pre style="white-space:pre-wrap">${m.body_text || ''}</pre>`}
    </div>`;

  const quotedText = `\n\n> On ${sentDate}, ${m.from_name || m.from_address} wrote:\n> ${(m.body_text || '').split('\n').map((l: string) => `> ${l}`).join('\n')}`;

  let to: Array<{ address: string; name?: string }> = [];
  let cc: Array<{ address: string; name?: string }> = [];

  const parseAddrs = (v: any): Array<{ address: string; name?: string }> => {
    try {
      return Array.isArray(v) ? v : JSON.parse(typeof v === 'string' ? v : '[]');
    } catch { return []; }
  };

  if (type === 'reply') {
    to = [{ address: m.from_address, name: m.from_name ?? undefined }];
  } else if (type === 'reply_all') {
    const myEmail = (m.my_email ?? '').toLowerCase();
    to = [{ address: m.from_address, name: m.from_name ?? undefined }];

    for (const addr of parseAddrs(m.to_addresses)) {
      if (addr.address?.toLowerCase() !== myEmail) to.push(addr);
    }
    for (const addr of parseAddrs(m.cc_addresses)) {
      if (addr.address?.toLowerCase() !== myEmail) cc.push(addr);
    }
  }
  // forward: to stays empty

  const existingRefs = m.references_header || '';
  const newRefs = [existingRefs, m.message_id].filter(Boolean).join(' ').trim();

  return {
    to,
    cc,
    subject,
    bodyHtml: quotedHtml,
    bodyText: quotedText,
    inReplyTo: type !== 'forward' ? (m.message_id ?? null) : null,
    references: newRefs || null,
    originalMessageId: messageId,
  };
}

// ═══ DRAFTS ══════════════════════════════════════════════════════════════════

export interface DraftData {
  identityId?: string | null;
  to: Array<{ address: string; name?: string }>;
  cc?: Array<{ address: string; name?: string }>;
  bcc?: Array<{ address: string; name?: string }>;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  priority?: 'high' | 'normal' | 'low';
  requestReadReceipt?: boolean;
  inReplyTo?: string | null;
  references?: string | null;
  replyType?: 'reply' | 'reply_all' | 'forward' | null;
  originalMsgId?: string | null;
  attachments?: any[];
}

/**
 * Creates or updates a draft. Returns the draft ID.
 */
export async function saveDraft(
  db: Database,
  draftId: string | null,
  accountId: string,
  data: DraftData,
): Promise<string> {
  const toJson = (v: any) => JSON.stringify(v ?? []);

  if (draftId) {
    await sql`
      UPDATE zv_mail_drafts SET
        identity_id     = ${data.identityId ?? null},
        to_addresses    = ${toJson(data.to)}::jsonb,
        cc_addresses    = ${toJson(data.cc)}::jsonb,
        bcc_addresses   = ${toJson(data.bcc)}::jsonb,
        subject         = ${data.subject},
        body_html       = ${data.bodyHtml},
        body_text       = ${data.bodyText ?? ''},
        priority        = ${data.priority ?? 'normal'},
        request_read_receipt = ${data.requestReadReceipt ?? false},
        in_reply_to     = ${data.inReplyTo ?? null},
        references_hdr  = ${data.references ?? null},
        reply_type      = ${data.replyType ?? null},
        original_msg_id = ${data.originalMsgId ?? null},
        attachments     = ${toJson(data.attachments)}::jsonb,
        auto_saved_at   = NOW(),
        updated_at      = NOW()
      WHERE id = ${draftId}
    `.execute(db);
    return draftId;
  }

  const inserted = await sql<{ id: string }>`
    INSERT INTO zv_mail_drafts (
      account_id, identity_id, to_addresses, cc_addresses, bcc_addresses,
      subject, body_html, body_text, priority, request_read_receipt,
      in_reply_to, references_hdr, reply_type, original_msg_id, attachments, auto_saved_at
    ) VALUES (
      ${accountId}, ${data.identityId ?? null},
      ${toJson(data.to)}::jsonb, ${toJson(data.cc)}::jsonb, ${toJson(data.bcc)}::jsonb,
      ${data.subject}, ${data.bodyHtml}, ${data.bodyText ?? ''},
      ${data.priority ?? 'normal'}, ${data.requestReadReceipt ?? false},
      ${data.inReplyTo ?? null}, ${data.references ?? null},
      ${data.replyType ?? null}, ${data.originalMsgId ?? null},
      ${toJson(data.attachments)}::jsonb, NOW()
    )
    RETURNING id
  `.execute(db);

  return (inserted.rows[0] as any).id;
}

/**
 * Sends a draft through SMTP, then deletes the draft.
 * Resolves identity, appends signature, auto-collects contacts.
 */
export async function sendDraft(
  db: Database,
  draftId: string,
  userId: string,
): Promise<{ messageId: string }> {
  // Load draft + account in one join
  const draftResult = await sql`
    SELECT d.*, a.email_address, a.display_name AS account_display_name,
           a.imap_user, a.imap_password, a.smtp_host, a.smtp_port,
           a.smtp_secure, a.smtp_user, a.smtp_password
    FROM zv_mail_drafts d
    INNER JOIN zv_mail_accounts a ON a.id = d.account_id
    WHERE d.id = ${draftId} AND a.user_id = ${userId}
  `.execute(db);

  if (!draftResult.rows[0]) throw new Error('Draft not found');
  const d = draftResult.rows[0] as any;

  // Resolve identity (overrides account email if set)
  let fromEmail = d.email_address;
  let fromName = d.account_display_name;

  if (d.identity_id) {
    const identityResult = await sql`
      SELECT email_address, display_name, signature_id FROM zv_mail_identities WHERE id = ${d.identity_id}
    `.execute(db);
    if (identityResult.rows[0]) {
      const id = identityResult.rows[0] as any;
      fromEmail = id.email_address;
      fromName = id.display_name;

      // Append signature
      if (id.signature_id) {
        const sigResult = await sql`SELECT body_html FROM zv_mail_signatures WHERE id = ${id.signature_id}`.execute(db);
        if (sigResult.rows[0]) {
          d.body_html += `<br>--<br>${(sigResult.rows[0] as any).body_html}`;
        }
      }
    }
  }

  const parseAddrs = (v: any): string[] => {
    try {
      const arr = Array.isArray(v) ? v : JSON.parse(typeof v === 'string' ? v : '[]');
      return arr.map((a: any) => a.address || a.email).filter(Boolean);
    } catch { return []; }
  };

  const toAddrs = parseAddrs(d.to_addresses);
  const ccAddrs = parseAddrs(d.cc_addresses);
  const bccAddrs = parseAddrs(d.bcc_addresses);

  const accountForSend = {
    ...d,
    email_address: fromEmail,
    display_name: fromName,
  };

  const result = await sendMail(
    accountForSend,
    toAddrs,
    d.subject,
    d.body_html,
    d.body_text,
    ccAddrs.length ? ccAddrs : undefined,
    bccAddrs.length ? bccAddrs : undefined,
    undefined,
    d.in_reply_to ?? undefined,
  );

  // Delete sent draft
  await sql`DELETE FROM zv_mail_drafts WHERE id = ${draftId}`.execute(db);

  // Auto-collect contacts (fire-and-forget)
  autoCollectContacts(db, userId, toAddrs).catch(() => { /* non-critical */ });

  return result;
}

// ═══ CONTACTS ════════════════════════════════════════════════════════════════

export async function autoCollectContacts(
  db: Database,
  userId: string,
  emails: string[],
): Promise<void> {
  for (const email of emails) {
    const clean = email.trim().toLowerCase();
    if (!clean || !clean.includes('@')) continue;
    await sql`
      INSERT INTO zv_mail_contacts (user_id, email, frequency, last_used_at, source)
      VALUES (${userId}, ${clean}, 1, NOW(), 'auto')
      ON CONFLICT (user_id, email) DO UPDATE SET
        frequency    = zv_mail_contacts.frequency + 1,
        last_used_at = NOW()
    `.execute(db).catch(() => { /* ignore row-level errors */ });
  }
}
