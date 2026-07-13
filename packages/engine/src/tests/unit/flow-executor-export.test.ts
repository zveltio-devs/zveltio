/**
 * export_collection success path — mocks optional export-manager + email modules.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const exportMock = mock(async () => ({
  buffer: new Uint8Array([99, 115, 118]),
  filename: 'contacts-export.csv',
}));

const emailAttachMock = mock(async () => {});
const sendDirectMock = mock<(opts: unknown) => Promise<void>>(async () => {
  throw new Error('Email service not configured');
});

mock.module('../../lib/export-manager.js', () => ({
  ExportManager: { export: exportMock },
}));

mock.module('../../lib/email.js', () => ({
  sendEmailWithAttachment: emailAttachMock,
  sendEmailDirectly: sendDirectMock,
}));

const { _internalForTests } = await import('../../lib/flows/flow-executor.js');
const { executeStep } = _internalForTests;

describe('executeStep — export_collection (mocked ExportManager)', () => {
  it('exports rows and returns counts when the export service is available', async () => {
    const db = new CannedDb();
    db.when(/set_config/i, []);
    db.when(/from "zvd_contacts"/i, [
      { id: '1', title: 'One' },
      { id: '2', title: 'Two' },
    ]);

    const { output } = await executeStep(
      db.kysely as unknown as Database,
      {
        type: 'export_collection',
        config: { collection: 'contacts', format: 'csv', limit: 100 },
      },
      {},
      {},
    );

    expect(output.exported).toBe(true);
    expect(output.rows).toBe(2);
    expect(exportMock).toHaveBeenCalled();
  });

  it('emails the export when email_to is configured', async () => {
    const db = new CannedDb();
    db.when(/set_config/i, []);
    db.when(/from "zvd_reports"/i, [{ id: '1', total: 9 }]);

    const { output } = await executeStep(
      db.kysely as unknown as Database,
      {
        type: 'export_collection',
        config: {
          collection: 'reports',
          format: 'csv',
          email_to: 'ops@example.com',
          filename: 'monthly',
        },
      },
      {},
      {},
    );

    expect(output.exported).toBe(true);
    expect(output.sent_to).toBe('ops@example.com');
    expect(emailAttachMock).toHaveBeenCalled();
  });

  it('skips email when email_to is set but ExportManager returns no buffer', async () => {
    emailAttachMock.mockClear();
    // @ts-expect-error — deliberate missing buffer to hit the non-email branch
    exportMock.mockImplementationOnce(async () => ({ filename: 'reports-export.csv' }));
    const db = new CannedDb();
    db.when(/set_config/i, []);
    db.when(/from "zvd_reports"/i, [{ id: '1', total: 9 }]);

    const { output } = await executeStep(
      db.kysely as unknown as Database,
      {
        type: 'export_collection',
        config: {
          collection: 'reports',
          format: 'csv',
          email_to: 'ops@example.com',
        },
      },
      {},
      {},
    );

    expect(output.exported).toBe(true);
    expect(output.rows).toBe(1);
    expect(output.sent_to).toBeUndefined();
    expect(emailAttachMock).not.toHaveBeenCalled();
  });

  it('emails an excel export with the xlsx content type', async () => {
    const db = new CannedDb();
    db.when(/set_config/i, []);
    db.when(/from "zvd_reports"/i, [{ id: '1' }]);

    const { output } = await executeStep(
      db.kysely as unknown as Database,
      {
        type: 'export_collection',
        config: {
          collection: 'reports',
          format: 'excel',
          email_to: 'finance@example.com',
          filename: 'q1',
        },
      },
      {},
      {},
    );

    expect(output.exported).toBe(true);
    expect(output.sent_to).toBe('finance@example.com');
    expect(emailAttachMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: expect.objectContaining({
          contentType: expect.stringContaining('spreadsheetml'),
          filename: expect.stringMatching(/\.xlsx$/),
        }),
      }),
    );
  });
});

describe('executeStep — send_email (mocked email.js)', () => {
  it('sends mail when the optional email service is configured', async () => {
    sendDirectMock.mockImplementation(async () => {});
    try {
      const { output } = await executeStep(
        new CannedDb().kysely as unknown as Database,
        {
          type: 'send_email',
          config: {
            to: 'user@example.com',
            subject: 'Hello\r\nInjected: nope',
            body: 'plain body',
          },
        },
        {},
        {},
      );
      expect(output.sent).toBe(true);
      expect(output.to).toBe('user@example.com');
      expect(sendDirectMock).toHaveBeenCalled();
    } finally {
      sendDirectMock.mockImplementation(async () => {
        throw new Error('Email service not configured');
      });
    }
  });
});
