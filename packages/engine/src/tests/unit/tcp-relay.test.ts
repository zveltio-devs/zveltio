/**
 * The TCP relay (ADR 0026 amendment): a stream reaches only the exact bound
 * host:port, a private address only when the binding is marked private, cloud
 * metadata never, and TLS is verified against the name the job asked for — a
 * certificate nobody trusts, or one for another name, is refused. STARTTLS is
 * refused while the server's plaintext is unread.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import { parseTarget, TCP_LIMITS, TcpRelay, tcpAuthority } from '../../lib/extensions/tcp-relay.js';

const dir = mkdtempSync(join(tmpdir(), 'zv-tcp-relay-'));
/** A self-signed certificate for `san`; its PEM is also the trust root that accepts it. */
function cert(name: string, san: string): { key: string; cert: string } {
  const key = join(dir, `${name}.key`);
  const crt = join(dir, `${name}.crt`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      crt,
      '-days',
      '1',
      '-subj',
      `/CN=${name}`,
      '-addext',
      `subjectAltName=${san}`,
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(crt, 'utf8') };
}

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );

const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));
const priv = (...authorities: string[]) => ({ authorities, private: true });

describe('tcp relay', () => {
  let good: { key: string; cert: string };
  let other: { key: string; cert: string };
  const servers: Server[] = [];
  let plain = 0;
  let tls = 0;
  let wrongName = 0;
  let starttls = 0;
  let eager = 0;

  beforeAll(async () => {
    good = cert('good', 'IP:127.0.0.1,DNS:localhost');
    other = cert('other', 'DNS:other.test');
    // Echo, upper-cased, so an answer is distinguishable from the request.
    const echo = (s: Socket) => s.on('data', (d) => s.write(d.toString().toUpperCase()));
    const add = (s: Server) => {
      servers.push(s);
      return listen(s);
    };
    plain = await add(createServer(echo));
    tls = await add(createTlsServer(good, echo));
    wrongName = await add(createTlsServer(other, echo));
    // A STARTTLS greeting: `* OK`, then `STARTTLS` → `OK`, then TLS on the same socket.
    starttls = await add(
      createServer((s) => {
        s.write('* OK ready\r\n');
        s.once('data', () => {
          s.write('OK begin\r\n', () => {
            const t = new TLSSocket(s, { isServer: true, ...good });
            echo(t as unknown as Socket);
          });
        });
      }),
    );
    // Sends its greeting and, unasked, more: plaintext that must not pass for TLS.
    eager = await add(createServer((s) => s.write('* OK ready\r\nINJECTED\r\n')));
  });

  afterAll(() => {
    for (const s of servers) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('spells authorities as a binding does, and validates the options', () => {
    expect(tcpAuthority('Mail.Example.COM', 993)).toBe('mail.example.com:993');
    expect(tcpAuthority('::1', 25)).toBe('[::1]:25');
    expect(() => tcpAuthority('a.b', 0)).toThrow('1-65535');
    expect(() => parseTarget({ host: 'a.b', port: 993 })).toThrow('tls');
    expect(parseTarget({ host: 'a.b', port: 993, tls: 'implicit' })).toEqual({
      host: 'a.b',
      port: 993,
      tls: 'implicit',
    });
  });

  it('reaches only the exact bound host:port', async () => {
    const r = new TcpRelay();
    const t = { host: '127.0.0.1', port: plain, tls: 'none' as const };
    await expect(r.connect(t, priv(`127.0.0.1:${plain + 1}`))).rejects.toThrow('is not bound');
    // A binding without a port binds nothing a stream can reach.
    await expect(r.connect(t, priv('127.0.0.1'))).rejects.toThrow('is not bound');
    const id = await r.connect(t, priv(`127.0.0.1:${plain}`));
    await r.write(id, new TextEncoder().encode('ping'));
    expect(text(await r.read(id, 100))).toBe('PING');
    r.closeAll();
  });

  it('a private address only when the binding is marked private, metadata never', async () => {
    const r = new TcpRelay();
    const t = { host: '127.0.0.1', port: plain, tls: 'none' as const };
    await expect(
      r.connect(t, { authorities: [`127.0.0.1:${plain}`], private: false }),
    ).rejects.toThrow(/private address blocked/);
    await expect(
      r.connect({ host: '169.254.169.254', port: 80, tls: 'none' }, priv('169.254.169.254:80')),
    ).rejects.toThrow(/metadata/);
    r.closeAll();
  });

  it('verifies TLS: an untrusted certificate and a wrong name are refused', async () => {
    const t = { host: '127.0.0.1', port: tls, tls: 'implicit' as const };
    await expect(new TcpRelay().connect(t, priv(`127.0.0.1:${tls}`))).rejects.toThrow();

    const trusting = new TcpRelay(good.cert + other.cert);
    const id = await trusting.connect(t, priv(`127.0.0.1:${tls}`));
    await trusting.write(id, new TextEncoder().encode('over tls'));
    expect(text(await trusting.read(id))).toBe('OVER TLS');
    // Trusted, but issued for other.test: not the name asked for.
    await expect(
      trusting.connect(
        { host: '127.0.0.1', port: wrongName, tls: 'implicit' },
        priv(`127.0.0.1:${wrongName}`),
      ),
    ).rejects.toThrow();
    trusting.closeAll();
  });

  it('upgrades a starttls stream when asked, and verifies it', async () => {
    const r = new TcpRelay(good.cert);
    const id = await r.connect(
      { host: '127.0.0.1', port: starttls, tls: 'starttls' },
      priv(`127.0.0.1:${starttls}`),
    );
    expect(text(await r.read(id))).toBe('* OK ready\r\n');
    await r.write(id, new TextEncoder().encode('STARTTLS\r\n'));
    expect(text(await r.read(id))).toBe('OK begin\r\n');
    const upgrading = r.startTls(id);
    // Nothing meant for TLS goes out in clear while the handshake runs.
    await expect(r.write(id, new TextEncoder().encode('AUTH secret'))).rejects.toThrow(
      'handshake is running',
    );
    await upgrading;
    await r.write(id, new TextEncoder().encode('secret'));
    expect(text(await r.read(id))).toBe('SECRET');
    r.closeAll();
  });

  it('refuses STARTTLS while plaintext is unread, and implicit streams', async () => {
    const r = new TcpRelay(good.cert);
    const id = await r.connect(
      { host: '127.0.0.1', port: eager, tls: 'starttls' },
      priv(`127.0.0.1:${eager}`),
    );
    await Bun.sleep(100);
    await expect(r.startTls(id)).rejects.toThrow('before the TLS handshake');
    const plainId = await r.connect(
      { host: '127.0.0.1', port: plain, tls: 'none' },
      priv(`127.0.0.1:${plain}`),
    );
    await expect(r.startTls(plainId)).rejects.toThrow('not opened starttls');
    r.closeAll();
  });

  it('answers null once the server closed, and caps the streams of a run', async () => {
    const closing = createServer((s) => s.end('bye'));
    servers.push(closing);
    const port = await listen(closing);
    const r = new TcpRelay();
    const t = { host: '127.0.0.1', port, tls: 'none' as const };
    const id = await r.connect(t, priv(`127.0.0.1:${port}`));
    expect(text(await r.read(id))).toBe('bye');
    expect(await r.read(id)).toBeNull();
    for (let i = 1; i < TCP_LIMITS.streams; i++) await r.connect(t, priv(`127.0.0.1:${port}`));
    await expect(r.connect(t, priv(`127.0.0.1:${port}`))).rejects.toThrow('tcp streams in one run');
    r.closeAll();
  });

  it('opens nothing once the run has ended', async () => {
    const r = new TcpRelay();
    const t = { host: '127.0.0.1', port: plain, tls: 'none' as const };
    const pending = r.connect(t, priv(`127.0.0.1:${plain}`));
    r.closeAll();
    await expect(pending).rejects.toThrow('run has ended');
    await expect(r.connect(t, priv(`127.0.0.1:${plain}`))).rejects.toThrow('run has ended');
  });
});
