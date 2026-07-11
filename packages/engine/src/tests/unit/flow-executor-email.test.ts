/**
 * send_email success path — isolated email mock (does not affect flow-executor-export.test.ts).
 */

import { describe, expect, it, mock } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const sendDirectMock = mock(async () => {});

mock.module('../../lib/email.js', () => ({
  sendEmailDirectly: sendDirectMock,
  sendEmailWithAttachment: async () => {},
}));

const { _internalForTests } = await import('../../lib/flows/flow-executor.js');
const { executeStep } = _internalForTests;

describe('executeStep — send_email (mocked email.js)', () => {
  it('sends mail when the optional email service is configured', async () => {
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
  });
});
