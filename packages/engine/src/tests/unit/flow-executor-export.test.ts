/**
 * export_collection (flow-executor.ts) — CSV export, optionally emailed.
 *
 * The step used to hand the rows to `lib/export-manager.js`, a module that has
 * never existed. Every run reported `{ exported: false, error: 'Export service
 * not configured' }`, and the tests here mocked the missing module into being.
 * The step now writes the CSV itself (recordsToCsv), and the email goes through
 * the engine's SMTP transport — nodemailer is what is mocked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Database } from '../../db/index.js';
import { _internalForTests as emailInternals } from '../../lib/email.js';
import { _internalForTests } from '../../lib/flows/flow-executor.js';
import { CannedDb } from './fixtures/canned-db.js';

const { executeStep } = _internalForTests;

const sendMailMock = mock(async (_msg: Record<string, unknown>) => ({ messageId: 'm' }));

mock.module('nodemailer', () => ({
  createTransport: () => ({ sendMail: sendMailMock }),
}));

let savedHost: string | undefined;
beforeAll(() => {
  savedHost = process.env.SMTP_HOST;
  process.env.SMTP_HOST = 'smtp.example.com';
  emailInternals.resetSmtpCacheForTests();
});
afterAll(() => {
  if (savedHost === undefined) delete process.env.SMTP_HOST;
  else process.env.SMTP_HOST = savedHost;
  emailInternals.resetSmtpCacheForTests();
});
beforeEach(() => {
  sendMailMock.mockClear();
  sendMailMock.mockImplementation(async () => ({ messageId: 'm' }));
});

function run(table: string, rows: Record<string, unknown>[], config: Record<string, unknown>) {
  const db = new CannedDb();
  db.when(/set_config/i, []);
  db.when(new RegExp(`from "${table}"`, 'i'), rows);
  return {
    db,
    result: executeStep(
      db.kysely as unknown as Database,
      { type: 'export_collection', config },
      {},
      {},
    ),
  };
}

describe('executeStep — export_collection', () => {
  it('returns the CSV as the step output when there is no recipient', async () => {
    const { result } = run(
      'zvd_contacts',
      [
        { id: '1', title: 'One' },
        { id: '2', title: '=HYPERLINK("http://evil")' },
      ],
      { collection: 'contacts' },
    );
    const { output } = await result;

    expect(output.exported).toBe(true);
    expect(output.rows).toBe(2);
    expect(output.filename).toBe('contacts.csv');
    // Header + rows, and a formula-looking cell neutralised for spreadsheets.
    expect(output.csv).toBe('"id","title"\r\n"1","One"\r\n"2","\'=HYPERLINK(""http://evil"")"');
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('keeps only the configured columns, in their order', async () => {
    const { result } = run('zvd_contacts', [{ id: '1', title: 'One', secret: 's' }], {
      collection: 'contacts',
      columns: ['title', 'id'],
    });
    const { output } = await result;
    expect(output.csv).toBe('"title","id"\r\n"One","1"');
  });

  it('accepts the zvd_ prefix on the collection name', async () => {
    const { db, result } = run('zvd_contacts', [{ id: 'c1' }], { collection: 'zvd_contacts' });
    const { output } = await result;
    expect(output.rows).toBe(1);
    expect(db.executed(/from "zvd_contacts"/i)).toHaveLength(1);
  });

  it('emails the CSV as an attachment when email_to is set', async () => {
    const { result } = run('zvd_reports', [{ id: '1', total: 9 }], {
      collection: 'reports',
      email_to: 'ops@example.com',
      filename: 'monthly',
    });
    const { output } = await result;

    expect(output).toEqual({ exported: true, sent_to: 'ops@example.com', rows: 1 });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const msg = sendMailMock.mock.calls[0][0] as {
      to: string;
      attachments: { filename: string; content: string; contentType: string }[];
    };
    expect(msg.to).toBe('ops@example.com');
    expect(msg.attachments).toEqual([
      { filename: 'monthly.csv', content: '"id","total"\r\n"1","9"', contentType: 'text/csv' },
    ]);
  });

  it('fails the step when the email cannot be sent', async () => {
    sendMailMock.mockImplementation(async () => {
      throw new Error('550 mailbox unavailable');
    });
    const { result } = run('zvd_reports', [{ id: '1' }], {
      collection: 'reports',
      email_to: 'ops@example.com',
    });
    await expect(result).rejects.toThrow(/550 mailbox unavailable/);
  });

  it('refuses a format other than csv instead of reporting an export', async () => {
    const { result } = run('zvd_reports', [{ id: '1' }], {
      collection: 'reports',
      format: 'excel',
    });
    await expect(result).rejects.toThrow(/format "excel" is not supported/);
  });
});
