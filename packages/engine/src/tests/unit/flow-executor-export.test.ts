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

mock.module('../../lib/export-manager.js', () => ({
  ExportManager: { export: exportMock },
}));

mock.module('../../lib/email.js', () => ({
  sendEmailWithAttachment: emailAttachMock,
  sendEmailDirectly: async () => {},
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
});
