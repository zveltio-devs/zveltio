// `zveltio install` and caller-credential forwarding (L8): the engine forwards
// a worker's declared credentials only once approved, so the CLI either sends
// the approval (--approve-forward-credentials) or says what stays withheld.
import { afterAll, beforeAll, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSession } from '../lib/engine-session.js';
import * as prompts from '../lib/prompt.js';
import { installCommand } from './install.js';

const FORWARD = { '/fwd': ['authorization'] };
let server: ReturnType<typeof Bun.serve>;
const installBodies: unknown[] = [];
const stepUps: string[] = [];
const config = mkdtempSync(join(tmpdir(), 'zv-cli-fwd-'));

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = config;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      // Signed in (ADR 0011); every mutation steps up for its own action.
      if (req.headers.get('authorization') !== 'Bearer tok')
        return new Response('', { status: 401 });
      if (path === '/api/auth/step-up/options') return Response.json({ method: 'totp' });
      if (path === '/api/auth/step-up/verify') {
        const { action } = (await req.json()) as { action: string };
        return Response.json({ token: `st:${action}` });
      }
      if (path !== '/api/marketplace') stepUps.push(req.headers.get('x-zveltio-step-up') ?? '');
      if (path === '/api/marketplace')
        return Response.json({
          extensions: [{ name: 'fwdext', is_installed: false, forwarded_credentials: FORWARD }],
        });
      if (path === '/api/marketplace/fwdext/install') {
        installBodies.push(await req.json().catch(() => null));
        return Response.json({ ok: true });
      }
      if (path === '/api/marketplace/fwdext/enable') return Response.json({ hot_loaded: true });
      return new Response('nope', { status: 404 });
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(config, { recursive: true, force: true });
});

it('sends the declared map as the approval only when asked to', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  // The second confirmation (enable) is typed at the terminal.
  const tty = process.stdin.isTTY;
  process.stdin.isTTY = true;
  const ask = spyOn(prompts, 'promptHidden').mockImplementation(async () => '333333');
  try {
    const url = `http://localhost:${server.port}`;
    saveSession(url, 'tok');
    await installCommand('fwdext', { url, totp: '111111' });
    await installCommand('fwdext', { url, approveForwardCredentials: true, totp: '222222' });
    expect(installBodies).toEqual([null, { forward_credentials: FORWARD }]);
    expect(stepUps).toEqual([
      'st:extension.install:fwdext',
      'st:extension.enable:fwdext',
      'st:extension.install:fwdext',
      'st:extension.enable:fwdext',
    ]);
    expect(log.mock.calls.flat().join('\n')).toContain('/fwd: authorization');
  } finally {
    process.stdin.isTTY = tty;
    ask.mockRestore();
    log.mockRestore();
  }
});
