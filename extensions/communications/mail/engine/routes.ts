import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../../../../packages/engine/src/db/index.js';
import { syncImapAccount, fetchMessageBody, sendMail } from './lib/imap-client.js';
import { aiProviderManager } from '../../../../packages/engine/src/lib/ai-provider.js';
import { checkPermission } from '../../../../packages/engine/src/lib/permissions.js';
import {
  createImapFolder, renameImapFolder, deleteImapFolder,
  moveMessages, downloadMessageAsEml, getImapQuota,
} from './lib/imap-operations.js';
import { buildReplyContext, saveDraft, sendDraft, autoCollectContacts } from './lib/compose.js';
import { compileFiltersToSieve, uploadSieveScript, applyLocalFilters } from './lib/sieve.js';

/**
 * Mail Client routes — IMAP sync + SMTP send + AI features.
 * Mounted at /api/mail
 */
export function mailRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  // ═══ ACCOUNTS ═══

  // GET /api/mail/accounts
  app.get('/accounts', async (c) => {
    const user = c.get('user') as any;
    const accounts = await sql`
      SELECT id, name, email_address, display_name, imap_host, smtp_host,
        is_default, is_active, last_sync_at, sync_error, created_at
      FROM zv_mail_accounts WHERE user_id = ${user.id}
      ORDER BY is_default DESC, created_at
    `.execute(db);
    return c.json({ accounts: accounts.rows });
  });

  // POST /api/mail/accounts
  app.post('/accounts', zValidator('json', z.object({
    name: z.string().min(1),
    email_address: z.string().email(),
    display_name: z.string().optional(),
    imap_host: z.string().min(1),
    imap_port: z.number().default(993),
    imap_secure: z.boolean().default(true),
    imap_user: z.string().min(1),
    imap_password: z.string().min(1),
    smtp_host: z.string().min(1),
    smtp_port: z.number().default(587),
    smtp_secure: z.boolean().default(true),
    smtp_user: z.string().optional(),
    smtp_password: z.string().optional(),
    is_default: z.boolean().default(false),
  })), async (c) => {
    const user = c.get('user') as any;
    const data = c.req.valid('json');

    // Test IMAP connection
    try {
      const { ImapFlow } = await import('imapflow');
      const testClient = new ImapFlow({
        host: data.imap_host, port: data.imap_port, secure: data.imap_secure,
        auth: { user: data.imap_user, pass: data.imap_password },
        logger: false,
      });
      await testClient.connect();
      await testClient.logout();
    } catch (err: any) {
      return c.json({ error: `IMAP connection failed: ${err.message}` }, 400);
    }

    // If is_default, clear existing default
    if (data.is_default) {
      await sql`UPDATE zv_mail_accounts SET is_default = false WHERE user_id = ${user.id}`.execute(db);
    }

    const inserted = await sql`
      INSERT INTO zv_mail_accounts (
        user_id, name, email_address, display_name,
        imap_host, imap_port, imap_secure, imap_user, imap_password,
        smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, is_default
      ) VALUES (
        ${user.id}, ${data.name}, ${data.email_address}, ${data.display_name ?? null},
        ${data.imap_host}, ${data.imap_port}, ${data.imap_secure}, ${data.imap_user}, ${data.imap_password},
        ${data.smtp_host}, ${data.smtp_port}, ${data.smtp_secure},
        ${data.smtp_user ?? null}, ${data.smtp_password ?? null}, ${data.is_default}
      )
      RETURNING *
    `.execute(db);

    const account = inserted.rows[0] as any;

    // Initial sync — non-blocking
    syncImapAccount(db, account).catch((err) =>
      console.error(`[mail] Initial sync failed [${account.id}]:`, err)
    );

    return c.json({ account: { ...account, imap_password: '***', smtp_password: '***' } }, 201);
  });

  // PATCH /api/mail/accounts/:id
  app.patch('/accounts/:id', zValidator('json', z.object({
    name: z.string().min(1).optional(),
    display_name: z.string().optional(),
    is_default: z.boolean().optional(),
    is_active: z.boolean().optional(),
  })), async (c) => {
    const user = c.get('user') as any;
    const data = c.req.valid('json');

    if (data.is_default) {
      await sql`UPDATE zv_mail_accounts SET is_default = false WHERE user_id = ${user.id}`.execute(db);
    }

    await sql`
      UPDATE zv_mail_accounts SET
        name = COALESCE(${data.name ?? null}, name),
        display_name = COALESCE(${data.display_name ?? null}, display_name),
        is_default = COALESCE(${data.is_default ?? null}::boolean, is_default),
        is_active = COALESCE(${data.is_active ?? null}::boolean, is_active),
        updated_at = NOW()
      WHERE id = ${c.req.param('id')} AND user_id = ${user.id}
    `.execute(db);
    return c.json({ success: true });
  });

  // DELETE /api/mail/accounts/:id
  app.delete('/accounts/:id', async (c) => {
    const user = c.get('user') as any;
    await sql`DELETE FROM zv_mail_accounts WHERE id = ${c.req.param('id')} AND user_id = ${user.id}`.execute(db);
    return c.json({ success: true });
  });

  // POST /api/mail/accounts/:id/sync
  app.post('/accounts/:id/sync', async (c) => {
    const user = c.get('user') as any;
    const account = await sql`
      SELECT * FROM zv_mail_accounts WHERE id = ${c.req.param('id')} AND user_id = ${user.id}
    `.execute(db);
    if (!account.rows[0]) return c.json({ error: 'Account not found' }, 404);

    const result = await syncImapAccount(db, account.rows[0] as any);
    return c.json(result);
  });

  // ═══ FOLDERS ═══

  // GET /api/mail/accounts/:accountId/folders
  app.get('/accounts/:accountId/folders', async (c) => {
    const user = c.get('user') as any;
    const folders = await sql`
      SELECT f.* FROM zv_mail_folders f
      INNER JOIN zv_mail_accounts a ON a.id = f.account_id
      WHERE f.account_id = ${c.req.param('accountId')} AND a.user_id = ${user.id}
      ORDER BY
        CASE f.type
          WHEN 'inbox' THEN 0 WHEN 'sent' THEN 1 WHEN 'drafts' THEN 2
          WHEN 'archive' THEN 3 WHEN 'spam' THEN 4 WHEN 'trash' THEN 5
          ELSE 6 END,
        f.name
    `.execute(db);
    return c.json({ folders: folders.rows });
  });

  // ═══ MESSAGES ═══

  // GET /api/mail/folders/:folderId/messages
  app.get('/folders/:folderId/messages', async (c) => {
    const user = c.get('user') as any;
    const { page = '1', limit = '50', search, unread_only } = c.req.query();
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const unreadFilter = unread_only === 'true' ? 'AND m.is_read = false' : '';
    const searchFilter = search
      ? `AND to_tsvector('simple', COALESCE(m.subject, '') || ' ' || COALESCE(m.body_text, '')) @@ plainto_tsquery('simple', $4)`
      : '';
    const params: any[] = [c.req.param('folderId'), user.id, offset, ...(search ? [search] : [])];
    const limitParam = search ? '$5' : '$4';

    const query = `
      SELECT m.id, m.uid, m.from_address, m.from_name, m.to_addresses, m.subject,
        m.snippet, m.is_read, m.is_starred, m.has_attachments, m.sent_at, m.received_at, m.tags
      FROM zv_mail_messages m
      INNER JOIN zv_mail_accounts a ON a.id = m.account_id
      WHERE m.folder_id = $1 AND a.user_id = $2
      ${unreadFilter} ${searchFilter}
      ORDER BY m.received_at DESC
      LIMIT ${limitParam} OFFSET $3
    `;
    params.push(limitNum);

    const messages = await sql.raw(query, params).execute(db);
    return c.json({ messages: messages.rows });
  });

  // GET /api/mail/messages/:id
  app.get('/messages/:id', async (c) => {
    const user = c.get('user') as any;
    const msgResult = await sql`
      SELECT m.* FROM zv_mail_messages m
      INNER JOIN zv_mail_accounts a ON a.id = m.account_id
      WHERE m.id = ${c.req.param('id')} AND a.user_id = ${user.id}
    `.execute(db);

    if (!msgResult.rows[0]) return c.json({ error: 'Message not found' }, 404);
    const msg = msgResult.rows[0] as any;

    // Fetch body on-demand if not cached
    if (!msg.body_html && !msg.body_text && msg.uid) {
      const accountResult = await sql`SELECT * FROM zv_mail_accounts WHERE id = ${msg.account_id}`.execute(db);
      const folderResult = await sql`SELECT path FROM zv_mail_folders WHERE id = ${msg.folder_id}`.execute(db);

      if (accountResult.rows[0] && folderResult.rows[0]) {
        try {
          const body = await fetchMessageBody(
            accountResult.rows[0] as any,
            (folderResult.rows[0] as any).path,
            msg.uid,
          );
          await sql`
            UPDATE zv_mail_messages SET body_text = ${body.bodyText}, body_html = ${body.bodyHtml}
            WHERE id = ${msg.id}
          `.execute(db);
          msg.body_text = body.bodyText;
          msg.body_html = body.bodyHtml;
        } catch (err: any) {
          console.error(`[mail] fetchMessageBody failed:`, err.message);
        }
      }
    }

    // Mark as read
    if (!msg.is_read) {
      await sql`UPDATE zv_mail_messages SET is_read = true WHERE id = ${msg.id}`.execute(db);
      msg.is_read = true;
    }

    const attachments = await sql`
      SELECT id, filename, mime_type, size_bytes, is_inline
      FROM zv_mail_attachments WHERE message_id = ${msg.id}
    `.execute(db);

    return c.json({ message: { ...msg, attachments: attachments.rows } });
  });

  // PATCH /api/mail/messages/:id — Update flags
  app.patch('/messages/:id', zValidator('json', z.object({
    is_read: z.boolean().optional(),
    is_starred: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
  })), async (c) => {
    const user = c.get('user') as any;
    const { is_read, is_starred, tags } = c.req.valid('json');

    const sets: string[] = [];
    const params: any[] = [];

    if (is_read !== undefined) { sets.push(`is_read = $${params.length + 1}`); params.push(is_read); }
    if (is_starred !== undefined) { sets.push(`is_starred = $${params.length + 1}`); params.push(is_starred); }
    if (tags) { sets.push(`tags = $${params.length + 1}::text[]`); params.push(tags); }

    if (sets.length === 0) return c.json({ success: true });

    params.push(c.req.param('id'));
    params.push(user.id);

    await sql.raw(`
      UPDATE zv_mail_messages SET ${sets.join(', ')}
      WHERE id = $${params.length - 1}
      AND account_id IN (SELECT id FROM zv_mail_accounts WHERE user_id = $${params.length})
    `, params).execute(db);

    return c.json({ success: true });
  });

  // DELETE /api/mail/messages/:id — Soft delete (move to trash)
  app.delete('/messages/:id', async (c) => {
    const user = c.get('user') as any;
    // Find trash folder for this message's account
    const msgResult = await sql`
      SELECT m.account_id FROM zv_mail_messages m
      INNER JOIN zv_mail_accounts a ON a.id = m.account_id
      WHERE m.id = ${c.req.param('id')} AND a.user_id = ${user.id}
    `.execute(db);
    if (!msgResult.rows[0]) return c.json({ error: 'Not found' }, 404);

    const accountId = (msgResult.rows[0] as any).account_id;
    const trashResult = await sql`
      SELECT id FROM zv_mail_folders WHERE account_id = ${accountId} AND type = 'trash' LIMIT 1
    `.execute(db);

    if (trashResult.rows[0]) {
      await sql`
        UPDATE zv_mail_messages SET folder_id = ${(trashResult.rows[0] as any).id}
        WHERE id = ${c.req.param('id')}
      `.execute(db);
    } else {
      await sql`DELETE FROM zv_mail_messages WHERE id = ${c.req.param('id')}`.execute(db);
    }
    return c.json({ success: true });
  });

  // ═══ COMPOSE / SEND ═══

  // POST /api/mail/send
  app.post('/send', zValidator('json', z.object({
    account_id: z.string().uuid(),
    to: z.array(z.string().email()).min(1),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
    subject: z.string().min(1),
    body_html: z.string(),
    body_text: z.string().optional(),
    reply_to_message_id: z.string().uuid().optional(),
  })), async (c) => {
    const user = c.get('user') as any;
    const data = c.req.valid('json');

    const accountResult = await sql`
      SELECT * FROM zv_mail_accounts WHERE id = ${data.account_id} AND user_id = ${user.id}
    `.execute(db);
    if (!accountResult.rows[0]) return c.json({ error: 'Account not found' }, 404);
    const account = accountResult.rows[0] as any;

    let inReplyTo: string | undefined;
    if (data.reply_to_message_id) {
      const original = await sql`
        SELECT message_id FROM zv_mail_messages WHERE id = ${data.reply_to_message_id}
      `.execute(db);
      inReplyTo = (original.rows[0] as any)?.message_id;
    }

    const result = await sendMail(
      account, data.to, data.subject, data.body_html,
      data.body_text, data.cc, data.bcc, undefined, inReplyTo,
    );

    // Save to local Sent folder
    const sentFolderResult = await sql`
      SELECT id FROM zv_mail_folders WHERE account_id = ${account.id} AND type = 'sent' LIMIT 1
    `.execute(db);

    if (sentFolderResult.rows[0]) {
      const folderId = (sentFolderResult.rows[0] as any).id;
      const snippet = data.body_html.replace(/<[^>]*>/g, '').slice(0, 200);
      await sql`
        INSERT INTO zv_mail_messages (
          account_id, folder_id, message_id, from_address, from_name,
          to_addresses, cc_addresses, subject, body_html, body_text,
          snippet, is_read, sent_at
        ) VALUES (
          ${account.id}, ${folderId}, ${result.messageId},
          ${account.email_address}, ${account.display_name ?? null},
          ${JSON.stringify(data.to.map((e: string) => ({ address: e })))}::jsonb,
          ${JSON.stringify((data.cc ?? []).map((e: string) => ({ address: e })))}::jsonb,
          ${data.subject}, ${data.body_html}, ${data.body_text ?? null},
          ${snippet}, true, NOW()
        )
      `.execute(db);
    }

    return c.json({ success: true, messageId: result.messageId });
  });

  // ═══ AI FEATURES ═══

  // POST /api/mail/messages/:id/summarize
  app.post('/messages/:id/summarize', async (c) => {
    const user = c.get('user') as any;
    const msgResult = await sql`
      SELECT m.subject, m.body_text FROM zv_mail_messages m
      INNER JOIN zv_mail_accounts a ON a.id = m.account_id
      WHERE m.id = ${c.req.param('id')} AND a.user_id = ${user.id}
    `.execute(db);

    if (!msgResult.rows[0]) return c.json({ error: 'Not found' }, 404);
    const { subject, body_text } = msgResult.rows[0] as any;

    const provider = aiProviderManager.getDefault();
    if (!provider?.chat) return c.json({ error: 'No AI provider configured' }, 503);

    const result = await provider.chat([
      { role: 'system', content: 'Summarize this email in 2-3 bullet points. Be concise.' },
      { role: 'user', content: `Subject: ${subject || '(no subject)'}\n\n${body_text || '(no body)'}` },
    ], { temperature: 0.3, max_tokens: 300 });

    return c.json({ summary: result.content });
  });

  // POST /api/mail/messages/:id/reply-draft — AI drafts a reply
  app.post('/messages/:id/reply-draft', async (c) => {
    const user = c.get('user') as any;
    const msgResult = await sql`
      SELECT m.subject, m.body_text, m.from_address, m.from_name FROM zv_mail_messages m
      INNER JOIN zv_mail_accounts a ON a.id = m.account_id
      WHERE m.id = ${c.req.param('id')} AND a.user_id = ${user.id}
    `.execute(db);

    if (!msgResult.rows[0]) return c.json({ error: 'Not found' }, 404);
    const { subject, body_text, from_address, from_name } = msgResult.rows[0] as any;

    const provider = aiProviderManager.getDefault();
    if (!provider?.chat) return c.json({ error: 'No AI provider configured' }, 503);

    const result = await provider.chat([
      { role: 'system', content: 'Draft a professional, concise email reply. Return only the reply body, no subject line.' },
      {
        role: 'user',
        content: `Original email from ${from_name || from_address}:
Subject: ${subject}

${body_text || '(no body)'}

Please draft a reply to this email.`,
      },
    ], { temperature: 0.5, max_tokens: 600 });

    return c.json({ draft: result.content });
  });

  // GET /api/mail/search — Full-text search across all accounts
  app.get('/search', async (c) => {
    const user = c.get('user') as any;
    const { q, limit = '20' } = c.req.query();
    if (!q || q.length < 2) return c.json({ messages: [] });

    const messages = await sql`
      SELECT m.id, m.from_address, m.from_name, m.subject, m.snippet,
        m.is_read, m.received_at, m.account_id, m.folder_id
      FROM zv_mail_messages m
      INNER JOIN zv_mail_accounts a ON a.id = m.account_id
      WHERE a.user_id = ${user.id}
        AND to_tsvector('simple', COALESCE(m.subject, '') || ' ' || COALESCE(m.body_text, ''))
          @@ plainto_tsquery('simple', ${q})
      ORDER BY m.received_at DESC
      LIMIT ${parseInt(limit)}
    `.execute(db);

    return c.json({ messages: messages.rows });
  });

  // ═══ FOLDER MANAGEMENT ═══

  // POST /api/mail/folders
  app.post('/folders', zValidator('json', z.object({
    account_id: z.string().uuid(),
    name: z.string().min(1),
    parent_path: z.string().optional(),
  })), async (c) => {
    const user = c.get('user') as any;
    const { account_id, name, parent_path } = c.req.valid('json');

    const accountResult = await sql`SELECT * FROM zv_mail_accounts WHERE id = ${account_id} AND user_id = ${user.id}`.execute(db);
    if (!accountResult.rows[0]) return c.json({ error: 'Account not found' }, 404);

    const fullPath = parent_path ? `${parent_path}.${name}` : name;
    await createImapFolder(accountResult.rows[0] as any, fullPath);
    await sql`
      INSERT INTO zv_mail_folders (account_id, name, path, type)
      VALUES (${account_id}, ${name}, ${fullPath}, 'other')
      ON CONFLICT (account_id, path) DO NOTHING
    `.execute(db);

    return c.json({ success: true, path: fullPath });
  });

  // PUT /api/mail/folders/:id/rename
  app.put('/folders/:id/rename', zValidator('json', z.object({ name: z.string().min(1) })), async (c) => {
    const user = c.get('user') as any;
    const folderResult = await sql`
      SELECT f.*, a.* FROM zv_mail_folders f
      INNER JOIN zv_mail_accounts a ON a.id = f.account_id
      WHERE f.id = ${c.req.param('id')} AND a.user_id = ${user.id}
    `.execute(db);
    if (!folderResult.rows[0]) return c.json({ error: 'Folder not found' }, 404);
    const folder = folderResult.rows[0] as any;

    const newName = c.req.valid('json').name;
    const newPath = folder.path.includes('.')
      ? folder.path.replace(/\.[^.]+$/, `.${newName}`)
      : newName;

    await renameImapFolder(folder, folder.path, newPath);
    await sql`UPDATE zv_mail_folders SET name = ${newName}, path = ${newPath} WHERE id = ${folder.id}`.execute(db);
    return c.json({ success: true });
  });

  // DELETE /api/mail/folders/:id
  app.delete('/folders/:id', async (c) => {
    const user = c.get('user') as any;
    const folderResult = await sql`
      SELECT f.*, a.* FROM zv_mail_folders f
      INNER JOIN zv_mail_accounts a ON a.id = f.account_id
      WHERE f.id = ${c.req.param('id')} AND a.user_id = ${user.id}
    `.execute(db);
    if (!folderResult.rows[0]) return c.json({ error: 'Folder not found' }, 404);
    const folder = folderResult.rows[0] as any;

    if (['inbox', 'sent', 'drafts', 'trash'].includes(folder.type)) {
      return c.json({ error: 'Cannot delete system folders' }, 400);
    }

    await deleteImapFolder(folder, folder.path);
    await sql`DELETE FROM zv_mail_folders WHERE id = ${folder.id}`.execute(db);
    return c.json({ success: true });
  });

  // ═══ BULK OPERATIONS ═══

  // POST /api/mail/bulk
  app.post('/bulk', zValidator('json', z.object({
    message_ids: z.array(z.string().uuid()).min(1).max(500),
    action: z.enum(['mark_read', 'mark_unread', 'star', 'unstar', 'move', 'delete', 'spam']),
    target_folder_id: z.string().uuid().optional(),
  })), async (c) => {
    const user = c.get('user') as any;
    const { message_ids, action, target_folder_id } = c.req.valid('json');

    const idList = message_ids.join("','");
    const userFilter = `account_id IN (SELECT id FROM zv_mail_accounts WHERE user_id = '${user.id}')`;

    switch (action) {
      case 'mark_read':
        await sql.raw(`UPDATE zv_mail_messages SET is_read = true WHERE id IN ('${idList}') AND ${userFilter}`).execute(db);
        break;
      case 'mark_unread':
        await sql.raw(`UPDATE zv_mail_messages SET is_read = false WHERE id IN ('${idList}') AND ${userFilter}`).execute(db);
        break;
      case 'star':
        await sql.raw(`UPDATE zv_mail_messages SET is_starred = true WHERE id IN ('${idList}') AND ${userFilter}`).execute(db);
        break;
      case 'unstar':
        await sql.raw(`UPDATE zv_mail_messages SET is_starred = false WHERE id IN ('${idList}') AND ${userFilter}`).execute(db);
        break;
      case 'move':
        if (!target_folder_id) return c.json({ error: 'target_folder_id required' }, 400);
        await sql.raw(`UPDATE zv_mail_messages SET folder_id = '${target_folder_id}' WHERE id IN ('${idList}') AND ${userFilter}`).execute(db);
        break;
      case 'delete': {
        const firstMsg = await sql`SELECT account_id FROM zv_mail_messages WHERE id = ${message_ids[0]}`.execute(db);
        if (firstMsg.rows[0]) {
          const trashRes = await sql`SELECT id FROM zv_mail_folders WHERE account_id = ${(firstMsg.rows[0] as any).account_id} AND type = 'trash' LIMIT 1`.execute(db);
          if (trashRes.rows[0]) {
            await sql.raw(`UPDATE zv_mail_messages SET folder_id = '${(trashRes.rows[0] as any).id}' WHERE id IN ('${idList}') AND ${userFilter}`).execute(db);
            break;
          }
        }
        await sql.raw(`DELETE FROM zv_mail_messages WHERE id IN ('${idList}') AND ${userFilter}`).execute(db);
        break;
      }
      case 'spam': {
        const firstMsg2 = await sql`SELECT account_id FROM zv_mail_messages WHERE id = ${message_ids[0]}`.execute(db);
        if (firstMsg2.rows[0]) {
          const spamRes = await sql`SELECT id FROM zv_mail_folders WHERE account_id = ${(firstMsg2.rows[0] as any).account_id} AND type = 'spam' LIMIT 1`.execute(db);
          if (spamRes.rows[0]) {
            await sql.raw(`UPDATE zv_mail_messages SET folder_id = '${(spamRes.rows[0] as any).id}' WHERE id IN ('${idList}') AND ${userFilter}`).execute(db);
          }
        }
        break;
      }
    }

    return c.json({ success: true, affected: message_ids.length });
  });

  // ═══ DOWNLOAD EML ═══

  // GET /api/mail/messages/:id/eml
  app.get('/messages/:id/eml', async (c) => {
    const user = c.get('user') as any;
    const msgResult = await sql`
      SELECT m.uid, m.folder_id, a.imap_host, a.imap_port, a.imap_secure, a.imap_user, a.imap_password, a.oauth2_provider, a.oauth2_access_token
      FROM zv_mail_messages m
      INNER JOIN zv_mail_accounts a ON a.id = m.account_id
      WHERE m.id = ${c.req.param('id')} AND a.user_id = ${user.id}
    `.execute(db);
    if (!msgResult.rows[0]) return c.json({ error: 'Not found' }, 404);
    const m = msgResult.rows[0] as any;

    const folderResult = await sql`SELECT path FROM zv_mail_folders WHERE id = ${m.folder_id}`.execute(db);
    if (!folderResult.rows[0]) return c.json({ error: 'Folder not found' }, 404);

    const eml = await downloadMessageAsEml(m, (folderResult.rows[0] as any).path, m.uid);
    c.header('Content-Type', 'message/rfc822');
    c.header('Content-Disposition', 'attachment; filename="message.eml"');
    return c.body(eml as any);
  });

  // ═══ QUOTA ═══

  // GET /api/mail/accounts/:id/quota
  app.get('/accounts/:id/quota', async (c) => {
    const user = c.get('user') as any;
    const accountResult = await sql`SELECT * FROM zv_mail_accounts WHERE id = ${c.req.param('id')} AND user_id = ${user.id}`.execute(db);
    if (!accountResult.rows[0]) return c.json({ error: 'Account not found' }, 404);

    const quota = await getImapQuota(accountResult.rows[0] as any);
    return c.json({ quota });
  });

  // ═══ REPLY / FORWARD CONTEXT ═══

  // POST /api/mail/messages/:id/reply-context
  app.post('/messages/:id/reply-context', zValidator('json', z.object({
    type: z.enum(['reply', 'reply_all', 'forward']),
  })), async (c) => {
    const user = c.get('user') as any;
    try {
      const context = await buildReplyContext(db, c.req.param('id'), c.req.valid('json').type, user.id);
      return c.json(context);
    } catch (err: any) {
      return c.json({ error: err.message }, 404);
    }
  });

  // ═══ DRAFTS ═══

  // GET /api/mail/drafts
  app.get('/drafts', async (c) => {
    const user = c.get('user') as any;
    const drafts = await sql`
      SELECT d.id, d.subject, d.to_addresses, d.account_id, d.reply_type, d.priority,
             d.auto_saved_at, d.updated_at, a.email_address
      FROM zv_mail_drafts d
      INNER JOIN zv_mail_accounts a ON a.id = d.account_id
      WHERE a.user_id = ${user.id}
      ORDER BY d.updated_at DESC
    `.execute(db);
    return c.json({ drafts: drafts.rows });
  });

  // GET /api/mail/drafts/:id
  app.get('/drafts/:id', async (c) => {
    const user = c.get('user') as any;
    const result = await sql`
      SELECT d.* FROM zv_mail_drafts d
      INNER JOIN zv_mail_accounts a ON a.id = d.account_id
      WHERE d.id = ${c.req.param('id')} AND a.user_id = ${user.id}
    `.execute(db);
    if (!result.rows[0]) return c.json({ error: 'Draft not found' }, 404);
    return c.json({ draft: result.rows[0] });
  });

  // POST /api/mail/drafts — Create or autosave draft
  app.post('/drafts', zValidator('json', z.object({
    draft_id: z.string().uuid().nullable().optional(),
    account_id: z.string().uuid(),
    identity_id: z.string().uuid().nullable().optional(),
    to: z.array(z.object({ address: z.string(), name: z.string().optional() })).default([]),
    cc: z.array(z.object({ address: z.string(), name: z.string().optional() })).default([]),
    bcc: z.array(z.object({ address: z.string(), name: z.string().optional() })).default([]),
    subject: z.string().default(''),
    body_html: z.string().default(''),
    body_text: z.string().optional(),
    priority: z.enum(['high', 'normal', 'low']).default('normal'),
    request_read_receipt: z.boolean().default(false),
    in_reply_to: z.string().nullable().optional(),
    references: z.string().nullable().optional(),
    reply_type: z.enum(['reply', 'reply_all', 'forward']).nullable().optional(),
    original_msg_id: z.string().uuid().nullable().optional(),
    attachments: z.array(z.any()).default([]),
  })), async (c) => {
    const data = c.req.valid('json');
    const draftId = await saveDraft(db, data.draft_id ?? null, data.account_id, {
      identityId: data.identity_id,
      to: data.to,
      cc: data.cc,
      bcc: data.bcc,
      subject: data.subject,
      bodyHtml: data.body_html,
      bodyText: data.body_text,
      priority: data.priority,
      requestReadReceipt: data.request_read_receipt,
      inReplyTo: data.in_reply_to,
      references: data.references,
      replyType: data.reply_type,
      originalMsgId: data.original_msg_id,
      attachments: data.attachments,
    });
    return c.json({ draft_id: draftId });
  });

  // POST /api/mail/drafts/:id/send
  app.post('/drafts/:id/send', async (c) => {
    const user = c.get('user') as any;
    try {
      const result = await sendDraft(db, c.req.param('id'), user.id);
      return c.json({ success: true, messageId: result.messageId });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // DELETE /api/mail/drafts/:id
  app.delete('/drafts/:id', async (c) => {
    await sql`DELETE FROM zv_mail_drafts WHERE id = ${c.req.param('id')}`.execute(db);
    return c.json({ success: true });
  });

  // ═══ IDENTITIES ═══

  // GET /api/mail/accounts/:accountId/identities
  app.get('/accounts/:accountId/identities', async (c) => {
    const user = c.get('user') as any;
    const identities = await sql`
      SELECT i.* FROM zv_mail_identities i
      INNER JOIN zv_mail_accounts a ON a.id = i.account_id
      WHERE i.account_id = ${c.req.param('accountId')} AND a.user_id = ${user.id}
      ORDER BY i.is_default DESC, i.sort_order
    `.execute(db);
    return c.json({ identities: identities.rows });
  });

  // POST /api/mail/accounts/:accountId/identities
  app.post('/accounts/:accountId/identities', zValidator('json', z.object({
    email_address: z.string().email(),
    display_name: z.string().optional(),
    reply_to: z.string().email().optional(),
    bcc_self: z.boolean().default(false),
    is_default: z.boolean().default(false),
    signature_id: z.string().uuid().nullable().optional(),
  })), async (c) => {
    const data = c.req.valid('json');
    const result = await sql`
      INSERT INTO zv_mail_identities (account_id, email_address, display_name, reply_to, bcc_self, is_default, signature_id)
      VALUES (${c.req.param('accountId')}, ${data.email_address}, ${data.display_name ?? null},
              ${data.reply_to ?? null}, ${data.bcc_self}, ${data.is_default}, ${data.signature_id ?? null})
      RETURNING *
    `.execute(db);
    return c.json({ identity: result.rows[0] }, 201);
  });

  // DELETE /api/mail/accounts/:accountId/identities/:id
  app.delete('/accounts/:accountId/identities/:id', async (c) => {
    await sql`DELETE FROM zv_mail_identities WHERE id = ${c.req.param('id')} AND account_id = ${c.req.param('accountId')}`.execute(db);
    return c.json({ success: true });
  });

  // ═══ SIGNATURES ═══

  // GET /api/mail/signatures
  app.get('/signatures', async (c) => {
    const user = c.get('user') as any;
    const sigs = await sql`
      SELECT * FROM zv_mail_signatures WHERE user_id = ${user.id} ORDER BY is_default DESC, name
    `.execute(db);
    return c.json({ signatures: sigs.rows });
  });

  // POST /api/mail/signatures
  app.post('/signatures', zValidator('json', z.object({
    name: z.string().min(1),
    body_html: z.string(),
    body_text: z.string().optional(),
    is_default: z.boolean().default(false),
  })), async (c) => {
    const user = c.get('user') as any;
    const data = c.req.valid('json');
    const result = await sql`
      INSERT INTO zv_mail_signatures (user_id, name, body_html, body_text, is_default)
      VALUES (${user.id}, ${data.name}, ${data.body_html},
              ${data.body_text ?? data.body_html.replace(/<[^>]*>/g, '')}, ${data.is_default})
      RETURNING *
    `.execute(db);
    return c.json({ signature: result.rows[0] }, 201);
  });

  // PUT /api/mail/signatures/:id
  app.put('/signatures/:id', zValidator('json', z.object({
    name: z.string().min(1).optional(),
    body_html: z.string().optional(),
    body_text: z.string().optional(),
    is_default: z.boolean().optional(),
  })), async (c) => {
    const user = c.get('user') as any;
    const data = c.req.valid('json');

    if (data.is_default) {
      await sql`UPDATE zv_mail_signatures SET is_default = false WHERE user_id = ${user.id}`.execute(db);
    }

    await sql`
      UPDATE zv_mail_signatures SET
        name = COALESCE(${data.name ?? null}, name),
        body_html = COALESCE(${data.body_html ?? null}, body_html),
        body_text = COALESCE(${data.body_text ?? null}, body_text),
        is_default = COALESCE(${data.is_default ?? null}::boolean, is_default),
        updated_at = NOW()
      WHERE id = ${c.req.param('id')} AND user_id = ${user.id}
    `.execute(db);
    return c.json({ success: true });
  });

  // DELETE /api/mail/signatures/:id
  app.delete('/signatures/:id', async (c) => {
    const user = c.get('user') as any;
    await sql`DELETE FROM zv_mail_signatures WHERE id = ${c.req.param('id')} AND user_id = ${user.id}`.execute(db);
    return c.json({ success: true });
  });

  // ═══ FILTERS (Sieve) ═══

  // GET /api/mail/accounts/:accountId/filters
  app.get('/accounts/:accountId/filters', async (c) => {
    const filters = await sql`
      SELECT * FROM zv_mail_filters WHERE account_id = ${c.req.param('accountId')} ORDER BY sort_order
    `.execute(db);
    return c.json({ filters: filters.rows });
  });

  // POST /api/mail/accounts/:accountId/filters
  app.post('/accounts/:accountId/filters', zValidator('json', z.object({
    name: z.string().min(1),
    conditions: z.array(z.object({
      field: z.enum(['from', 'to', 'subject', 'body', 'size', 'header']),
      operator: z.enum(['contains', 'is', 'begins_with', 'ends_with', 'greater_than', 'less_than']),
      value: z.string(),
      header_name: z.string().optional(),
    })).min(1),
    actions: z.array(z.object({
      type: z.enum(['move', 'copy', 'mark_read', 'mark_starred', 'delete', 'forward', 'reject', 'vacation', 'stop']),
      folder: z.string().optional(),
      address: z.string().optional(),
      message: z.string().optional(),
      flag: z.string().optional(),
      vacation_subject: z.string().optional(),
      vacation_days: z.number().optional(),
    })).min(1),
    is_active: z.boolean().default(true),
    sort_order: z.number().default(0),
  })), async (c) => {
    const data = c.req.valid('json');
    const accountId = c.req.param('accountId');

    // Compile Sieve script for all active filters
    const existing = await sql`SELECT * FROM zv_mail_filters WHERE account_id = ${accountId} AND is_active = true ORDER BY sort_order`.execute(db);
    const allRules = [...(existing.rows as any[]).map(r => ({
      name: r.name,
      is_active: r.is_active,
      conditions: typeof r.conditions === 'string' ? JSON.parse(r.conditions) : r.conditions,
      actions: typeof r.actions === 'string' ? JSON.parse(r.actions) : r.actions,
    })), { name: data.name, is_active: data.is_active, conditions: data.conditions, actions: data.actions }];

    const sieveScript = compileFiltersToSieve(allRules);

    const result = await sql`
      INSERT INTO zv_mail_filters (account_id, name, conditions, actions, is_active, sort_order, sieve_script)
      VALUES (${accountId}, ${data.name}, ${JSON.stringify(data.conditions)}::jsonb,
              ${JSON.stringify(data.actions)}::jsonb, ${data.is_active}, ${data.sort_order}, ${sieveScript})
      RETURNING *
    `.execute(db);

    // Upload to server async (fallback gracefully)
    const accountResult = await sql`SELECT * FROM zv_mail_accounts WHERE id = ${accountId}`.execute(db);
    if (accountResult.rows[0]) {
      uploadSieveScript(accountResult.rows[0] as any, 'zveltio', sieveScript).catch(() => { /* ignore */ });
    }

    return c.json({ filter: result.rows[0] }, 201);
  });

  // PATCH /api/mail/accounts/:accountId/filters/:id
  app.patch('/accounts/:accountId/filters/:id', zValidator('json', z.object({
    name: z.string().min(1).optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().optional(),
  })), async (c) => {
    const data = c.req.valid('json');
    await sql`
      UPDATE zv_mail_filters SET
        name = COALESCE(${data.name ?? null}, name),
        is_active = COALESCE(${data.is_active ?? null}::boolean, is_active),
        sort_order = COALESCE(${data.sort_order ?? null}::int, sort_order),
        updated_at = NOW()
      WHERE id = ${c.req.param('id')} AND account_id = ${c.req.param('accountId')}
    `.execute(db);
    return c.json({ success: true });
  });

  // DELETE /api/mail/accounts/:accountId/filters/:id
  app.delete('/accounts/:accountId/filters/:id', async (c) => {
    await sql`DELETE FROM zv_mail_filters WHERE id = ${c.req.param('id')} AND account_id = ${c.req.param('accountId')}`.execute(db);
    return c.json({ success: true });
  });

  // ═══ ADDRESS BOOK / AUTOCOMPLETE ═══

  // GET /api/mail/contacts?q=...
  app.get('/contacts', async (c) => {
    const user = c.get('user') as any;
    const q = c.req.query('q') || '';
    const limit = Math.min(50, parseInt(c.req.query('limit') || '10'));

    let contacts;
    if (q.length >= 2) {
      contacts = await sql`
        SELECT email, display_name, company, frequency
        FROM zv_mail_contacts
        WHERE user_id = ${user.id}
          AND (email ILIKE ${'%' + q + '%'} OR display_name ILIKE ${'%' + q + '%'})
        ORDER BY frequency DESC
        LIMIT ${limit}
      `.execute(db);
    } else {
      contacts = await sql`
        SELECT email, display_name, company, frequency
        FROM zv_mail_contacts
        WHERE user_id = ${user.id}
        ORDER BY frequency DESC
        LIMIT ${limit}
      `.execute(db);
    }
    return c.json({ contacts: contacts.rows });
  });

  // POST /api/mail/contacts — Manual add
  app.post('/contacts', zValidator('json', z.object({
    email: z.string().email(),
    display_name: z.string().optional(),
    company: z.string().optional(),
    phone: z.string().optional(),
  })), async (c) => {
    const user = c.get('user') as any;
    const data = c.req.valid('json');
    await sql`
      INSERT INTO zv_mail_contacts (user_id, email, display_name, company, phone, source)
      VALUES (${user.id}, ${data.email.toLowerCase()}, ${data.display_name ?? null},
              ${data.company ?? null}, ${data.phone ?? null}, 'manual')
      ON CONFLICT (user_id, email) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, zv_mail_contacts.display_name),
        company = COALESCE(EXCLUDED.company, zv_mail_contacts.company),
        phone = COALESCE(EXCLUDED.phone, zv_mail_contacts.phone)
    `.execute(db);
    return c.json({ success: true });
  });

  // ═══ READ RECEIPTS (MDN) ═══

  // POST /api/mail/messages/:id/read-receipt
  app.post('/messages/:id/read-receipt', async (c) => {
    const user = c.get('user') as any;
    const msgResult = await sql`
      SELECT m.*, a.email_address, a.display_name AS account_display_name,
             a.imap_user, a.imap_password, a.smtp_host, a.smtp_port, a.smtp_secure, a.smtp_user, a.smtp_password
      FROM zv_mail_messages m
      INNER JOIN zv_mail_accounts a ON a.id = m.account_id
      WHERE m.id = ${c.req.param('id')} AND a.user_id = ${user.id}
        AND m.read_receipt_requested = true AND m.read_receipt_sent = false
    `.execute(db);

    if (!msgResult.rows[0]) return c.json({ error: 'No read receipt needed or already sent' }, 400);
    const m = msgResult.rows[0] as any;

    const mdnBody = `This is a read receipt.\n\nYour message "${m.subject}" was read on ${new Date().toLocaleString()}.`;
    await sendMail(
      { ...m, display_name: m.account_display_name },
      [m.from_address],
      `Read: ${m.subject}`,
      `<p>${mdnBody.replace(/\n/g, '<br>')}</p>`,
      mdnBody,
    );

    await sql`UPDATE zv_mail_messages SET read_receipt_sent = true WHERE id = ${m.id}`.execute(db);
    return c.json({ success: true });
  });

  // ═══ ADMIN: MAIL CONFIG ═══

  // GET /api/mail/admin/config
  app.get('/admin/config', async (c) => {
    const user = c.get('user') as any;
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin required' }, 403);

    const config = await sql`SELECT value FROM zv_settings WHERE key = 'mail'`.execute(db);
    return c.json({ config: config.rows[0] ? (config.rows[0] as any).value : {} });
  });

  // PUT /api/mail/admin/config
  app.put('/admin/config', zValidator('json', z.object({
    enabled: z.boolean().optional(),
    max_accounts_per_user: z.number().int().min(1).max(50).optional(),
    max_attachment_size_mb: z.number().int().min(1).max(100).optional(),
    allowed_domains: z.array(z.string()).optional(),
    blocked_domains: z.array(z.string()).optional(),
    require_admin_approval: z.boolean().optional(),
    auto_collect_contacts: z.boolean().optional(),
    imap_idle_enabled: z.boolean().optional(),
    sieve_enabled: z.boolean().optional(),
    pgp_enabled: z.boolean().optional(),
    oauth2_gmail_client_id: z.string().optional(),
    oauth2_gmail_client_secret: z.string().optional(),
    oauth2_outlook_client_id: z.string().optional(),
    oauth2_outlook_client_secret: z.string().optional(),
    max_messages_sync: z.number().int().min(50).max(10000).optional(),
    sync_interval_minutes: z.number().int().min(1).max(60).optional(),
    trash_auto_delete_days: z.number().int().min(0).max(365).optional(),
  })), async (c) => {
    const user = c.get('user') as any;
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin required' }, 403);

    const current = await sql`SELECT value FROM zv_settings WHERE key = 'mail'`.execute(db);
    const existing = current.rows[0] ? (current.rows[0] as any).value : {};
    const merged = { ...existing, ...c.req.valid('json') };

    await sql`
      INSERT INTO zv_settings (key, value, description, is_public)
      VALUES ('mail', ${JSON.stringify(merged)}::jsonb, 'Mail client configuration (admin)', false)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `.execute(db);

    return c.json({ success: true });
  });

  // ═══ STATISTICS ═══

  // GET /api/mail/stats — per-user inbox stats
  app.get('/stats', async (c) => {
    const user = c.get('user') as any;
    const stats = await sql`
      SELECT
        COUNT(*) FILTER (WHERE NOT m.is_read AND f.type = 'inbox') AS unread_inbox,
        COUNT(*) FILTER (WHERE f.type = 'inbox') AS total_inbox,
        COUNT(*) FILTER (WHERE m.is_starred) AS starred,
        COUNT(DISTINCT m.account_id) AS accounts,
        (SELECT COUNT(*) FROM zv_mail_drafts d INNER JOIN zv_mail_accounts da ON da.id = d.account_id WHERE da.user_id = ${user.id}) AS drafts
      FROM zv_mail_messages m
      INNER JOIN zv_mail_folders f ON f.id = m.folder_id
      INNER JOIN zv_mail_accounts a ON a.id = m.account_id
      WHERE a.user_id = ${user.id}
    `.execute(db);
    return c.json({ stats: stats.rows[0] ?? {} });
  });

  return app;
}
