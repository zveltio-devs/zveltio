// `zveltio install` and caller-credential forwarding (L8): the engine forwards
// a worker's declared credentials only once approved, so the CLI either sends
// the approval (--approve-forward-credentials) or says what stays withheld.
import { afterAll, beforeAll, expect, it, spyOn } from 'bun:test';
import { installCommand } from './install.js';

const FORWARD = { '/fwd': ['authorization'] };
let server: ReturnType<typeof Bun.serve>;
const installBodies: unknown[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
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
afterAll(() => server.stop(true));

it('sends the declared map as the approval only when asked to', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    const url = `http://localhost:${server.port}`;
    await installCommand('fwdext', { url });
    await installCommand('fwdext', { url, approveForwardCredentials: true });
    expect(installBodies).toEqual([null, { forward_credentials: FORWARD }]);
    expect(log.mock.calls.flat().join('\n')).toContain('/fwd: authorization');
  } finally {
    log.mockRestore();
  }
});
