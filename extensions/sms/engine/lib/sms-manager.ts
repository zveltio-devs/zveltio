import type { Database } from '../../../../packages/engine/src/db/index.js';
import { sendViaTwilio } from './providers/twilio.js';
import { sendViaVonage } from './providers/vonage.js';

let _db: Database | null = null;

function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? '');
}

export interface SendOpts {
  provider: 'twilio' | 'vonage';
  to: string;
  body?: string;
  template_id?: string;
  variables?: Record<string, string>;
}

export const SmsManager = {
  init(db: Database): void {
    _db = db;
  },

  async send(opts: SendOpts): Promise<{ id: string; status: string }> {
    if (!_db) throw new Error('SmsManager not initialized');
    const db = _db;

    let body = opts.body ?? '';

    // Resolve template if provided
    if (opts.template_id) {
      const template = await (db as any)
        .selectFrom('zv_sms_templates')
        .selectAll()
        .where('id', '=', opts.template_id)
        .executeTakeFirst();
      if (!template) throw new Error(`SMS template ${opts.template_id} not found`);
      body = interpolate(template.body, opts.variables ?? {});
    }

    if (!body) throw new Error('SMS body is required');

    // Insert pending record
    const record = await (db as any)
      .insertInto('zv_sms_messages')
      .values({
        provider: opts.provider,
        to_number: opts.to,
        from_number: opts.provider === 'twilio'
          ? (process.env.TWILIO_FROM_NUMBER ?? null)
          : (process.env.VONAGE_FROM_NUMBER ?? null),
        body,
        status: 'pending',
      })
      .returningAll()
      .executeTakeFirst();

    const messageId = record.id as string;

    try {
      let providerMsgId: string;
      let providerStatus: string;

      if (opts.provider === 'twilio') {
        const result = await sendViaTwilio({
          accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
          authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
          from: process.env.TWILIO_FROM_NUMBER ?? '',
          to: opts.to,
          body,
        });
        providerMsgId = result.sid;
        providerStatus = result.status;
      } else {
        const result = await sendViaVonage({
          apiKey: process.env.VONAGE_API_KEY ?? '',
          apiSecret: process.env.VONAGE_API_SECRET ?? '',
          from: process.env.VONAGE_FROM_NUMBER ?? '',
          to: opts.to,
          text: body,
        });
        providerMsgId = result.messageId;
        providerStatus = result.status;
      }

      await (db as any)
        .updateTable('zv_sms_messages')
        .set({
          status: 'sent',
          provider_message_id: providerMsgId,
          sent_at: new Date(),
        })
        .where('id', '=', messageId)
        .execute();

      return { id: messageId, status: providerStatus };
    } catch (err: any) {
      await (db as any)
        .updateTable('zv_sms_messages')
        .set({
          status: 'failed',
          error: err.message ?? String(err),
        })
        .where('id', '=', messageId)
        .execute();
      throw err;
    }
  },

  async getStats(): Promise<Array<{ status: string; count: number }>> {
    if (!_db) return [];
    const since = new Date();
    since.setDate(since.getDate() - 7);

    const rows = await (_db as any)
      .selectFrom('zv_sms_messages')
      .select([
        'status',
        (eb: any) => eb.fn.count('id').as('count'),
      ])
      .where('created_at', '>=', since)
      .groupBy('status')
      .execute();

    return rows.map((r: any) => ({ status: r.status, count: Number(r.count) }));
  },
};
