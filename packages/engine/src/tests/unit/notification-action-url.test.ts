/**
 * Where a notification's link may point.
 *
 * `z.string().url()` alone accepts `javascript:alert(1)` and `data:text/html,…`,
 * and the push service worker navigates to the link on click. This file used to
 * assert a copy of the route's zod schema written inside the test — so the
 * route could drop its check and nothing here would notice, and the copy also
 * hid that `.url()` refused the in-app paths the message promised. It drives
 * the real validator and the in-process sender (flows, extensions) now.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { isSafeActionUrl, sendNotification } from '../../lib/notifications.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('isSafeActionUrl', () => {
  it('accepts http(s) links and in-app paths', () => {
    expect(isSafeActionUrl('https://zveltio.com/invoices/42')).toBe(true);
    expect(isSafeActionUrl('http://intranet.local/tickets/7')).toBe(true);
    // Refused by the old `.url()` schema although its message allowed it.
    expect(isSafeActionUrl('/intranet/notifications')).toBe(true);
  });

  it('refuses click-to-execute schemes and other schemes', () => {
    for (const u of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'dashboard',
    ]) {
      expect(isSafeActionUrl(u)).toBe(false);
    }
  });

  it('refuses an off-site link dressed as an in-app path', () => {
    expect(isSafeActionUrl('//evil.example/login')).toBe(false);
    expect(isSafeActionUrl('/\\evil.example/login')).toBe(false);
  });
});

describe('sendNotification — the path flows and extensions take', () => {
  async function stored(action_url: string): Promise<unknown[]> {
    const canned = new CannedDb();
    canned.when(/insert into "zv_notifications"/i, []);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await sendNotification(canned.kysely as unknown as Database, {
        user_id: 'u1',
        title: 't',
        message: 'm',
        action_url,
      });
    } finally {
      warn.mockRestore();
    }
    return canned.executed(/insert into "zv_notifications"/i)[0]!.parameters as unknown[];
  }

  it('drops an unsafe link and still sends the notification', async () => {
    const params = await stored('javascript:alert(1)');
    expect(params).toContain('u1');
    expect(params).not.toContain('javascript:alert(1)');
  });

  it('keeps a safe link', async () => {
    expect(await stored('/intranet/tickets/7')).toContain('/intranet/tickets/7');
  });
});
