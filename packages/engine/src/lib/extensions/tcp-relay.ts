/**
 * The TCP relay (ADR 0026 amendment 2026-11-07): a job's byte stream to a
 * host:port an operator bound to one of its `kind: "tcp"` slots. IMAP and SMTP
 * are not HTTP, so the engine-served fetch cannot carry them, and the job may
 * not open a socket (ADR 0022 zero permissions, ADR 0023 socket ban). The
 * engine opens it instead and the job drives it through host calls
 * (`tcp.read`, `tcp.write`, …) on the channel it already has.
 *
 * Imported lazily by `jobs.ts`, on the first `tcp.connect` of a bound slot: an
 * engine with no tcp binding never loads this module and opens nothing.
 *
 * Each target is checked as an HTTP slot's is: the exact `host:port` must be
 * bound, the name resolves to a public address unless the binding is marked
 * private (then anything but cloud metadata), and the socket connects to the
 * address that was checked, so a second resolution cannot move it. TLS always
 * verifies the certificate against the name the job asked for.
 */

import { connect as netConnect, type Socket } from 'node:net';
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from 'node:tls';
import { assertNonMetadataResolved, assertPublicUrl } from '../edge-functions/safe-fetch.js';

export const TCP_LIMITS = {
  /** Streams one run may open, in all. */
  streams: 4,
  /** A stream with no traffic either way this long is closed. */
  idleMs: 60_000,
  /** Opening a stream, TLS included. */
  connectMs: 15_000,
  /** Bytes read and written over every stream of one run. */
  bytes: 64 * 1024 * 1024,
  /** The most one `read` answers. */
  readChunk: 64 * 1024,
  /** Unread bytes held per stream before the socket is paused. */
  buffered: 256 * 1024,
};

export type TlsMode = 'implicit' | 'starttls' | 'none';

export interface TcpTarget {
  host: string;
  port: number;
  tls: TlsMode;
}

/** What an operator bound to the slot (`consent.ts` `SlotBinding`). */
export interface TcpBinding {
  authorities: readonly string[];
  private: boolean;
}

interface Stream {
  socket: Socket;
  target: TcpTarget;
  /** The name TLS verifies: the bound authority's host, as canonical as the binding. */
  name: string;
  /** A STARTTLS handshake is running: nothing is read or written until it ends. */
  upgrading: boolean;
  /** TLS is up: implicit from the start, or after `startTls`. */
  secure: boolean;
  chunks: Buffer[];
  size: number;
  ended: boolean;
  error: Error | null;
  wake: (() => void) | null;
}

/**
 * `host` and `port` as a bound authority spells them: lower case, an IPv6
 * literal in brackets, the port always written (a tcp binding carries one).
 */
export function tcpAuthority(host: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`tcp: port ${String(port)} is not 1-65535`);
  }
  const bare = host.replace(/^\[|\]$/g, '');
  let u: URL;
  try {
    u = new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}/`);
  } catch {
    throw new Error(`tcp: "${host}" is not a host`);
  }
  return `${u.hostname}:${port}`;
}

/** Validates the job's `{ host, port, tls }`; throws on anything else. */
export function parseTarget(v: unknown): TcpTarget {
  const o = v as Partial<TcpTarget> | null;
  if (
    o === null ||
    typeof o !== 'object' ||
    typeof o.host !== 'string' ||
    typeof o.port !== 'number' ||
    !['implicit', 'starttls', 'none'].includes(o.tls as string)
  ) {
    throw new Error(
      "tcp.connect: options are { host: string, port: number, tls: 'implicit' | 'starttls' | 'none' }",
    );
  }
  return { host: o.host, port: o.port, tls: o.tls as TlsMode };
}

/** One run's streams. `closeAll` when the run ends, however it ends; after it, nothing opens. */
export class TcpRelay {
  private readonly streams = new Map<number, Stream>();
  private opened = 0;
  private bytes = 0;
  private next = 0;
  private closed = false;

  /** `ca`: extra trust roots, for tests only; production verifies against the system's. */
  constructor(private readonly ca?: string) {}

  async connect(target: TcpTarget, binding: TcpBinding): Promise<number> {
    this.assertOpen();
    const authority = tcpAuthority(target.host, target.port);
    if (!binding.authorities.includes(authority)) {
      throw new Error(`[egress] ${authority} is not bound to this slot`);
    }
    if (++this.opened > TCP_LIMITS.streams) {
      throw new Error(`[egress] more than ${TCP_LIMITS.streams} tcp streams in one run`);
    }
    const host = authority.slice(0, authority.lastIndexOf(':'));
    const url = `http://${authority}/`;
    // The guard answers the address to connect to: the one it checked. Its DNS
    // lookup counts toward the connect deadline.
    const pinned = await deadline(
      binding.private ? assertNonMetadataResolved(url) : assertPublicUrl(url),
      `resolving ${host}`,
    );
    const name = host.replace(/^\[|\]$/g, '');
    const isLiteral = name !== host || /^[\d.]+$/.test(name);
    if (pinned === null && !isLiteral) throw new Error(`[egress] ${host} does not resolve`);
    const address = pinned ?? name;

    const socket = await this.open(target, name, address);
    // The run ended while this one opened: it is not handed out.
    if (this.closed) {
      socket.destroy();
      throw new Error('tcp.connect: the run has ended');
    }
    const id = ++this.next;
    const s: Stream = {
      socket,
      target,
      name,
      upgrading: false,
      secure: target.tls === 'implicit',
      chunks: [],
      size: 0,
      ended: false,
      error: null,
      wake: null,
    };
    this.streams.set(id, s);
    this.attach(s);
    return id;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('tcp: the run has ended');
  }

  private open(target: TcpTarget, name: string, address: string): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket =
        target.tls === 'implicit'
          ? tlsConnect({ ...this.tlsOptions(name), host: address, port: target.port })
          : netConnect({ host: address, port: target.port });
      const timer = setTimeout(
        () => fail(new Error(`[egress] connecting to ${name}:${target.port} timed out`)),
        TCP_LIMITS.connectMs,
      );
      const fail = (err: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      socket.once('error', fail);
      socket.once(target.tls === 'implicit' ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        socket.off('error', fail);
        resolve(socket);
      });
    });
  }

  private tlsOptions(name: string) {
    const isIp = name.includes(':') || /^[\d.]+$/.test(name);
    return {
      // SNI carries a name only; the certificate is checked against the bound
      // name, never against the address the socket was pinned to.
      ...(isIp ? {} : { servername: name }),
      checkServerIdentity: (_: string, cert: Parameters<typeof checkServerIdentity>[1]) =>
        checkServerIdentity(name, cert),
      rejectUnauthorized: true,
      ...(this.ca ? { ca: this.ca } : {}),
    };
  }

  private attach(s: Stream): void {
    const { socket } = s;
    // Idle means no traffic while the job could take some: paused for
    // backpressure (the job is not reading) does not count.
    socket.setTimeout(TCP_LIMITS.idleMs);
    socket.on('timeout', () => {
      if (!socket.isPaused()) {
        this.kill(s, new Error(`[egress] tcp stream idle for ${TCP_LIMITS.idleMs / 1000}s`));
      }
    });
    socket.on('data', (d: Buffer) => {
      if (this.count(d.length)) return;
      s.chunks.push(d);
      s.size += d.length;
      if (s.size >= TCP_LIMITS.buffered) socket.pause();
      this.wakeUp(s);
    });
    socket.on('end', () => {
      s.ended = true;
      this.wakeUp(s);
    });
    socket.on('error', (err) => this.kill(s, err));
    socket.on('close', () => {
      s.ended = true;
      this.wakeUp(s);
    });
  }

  private wakeUp(s: Stream): void {
    const w = s.wake;
    s.wake = null;
    w?.();
  }

  private kill(s: Stream, err: Error): void {
    s.error ??= err;
    s.socket.destroy();
    this.wakeUp(s);
  }

  /**
   * Adds to the run's bytes; past the ceiling every stream is closed and the
   * error answered. Never throws: it runs inside a socket's `data` event.
   */
  private count(n: number): Error | null {
    this.bytes += n;
    if (this.bytes <= TCP_LIMITS.bytes) return null;
    const err = new Error(`[egress] more than ${TCP_LIMITS.bytes} bytes over tcp in one run`);
    for (const s of this.streams.values()) this.kill(s, err);
    return err;
  }

  private get(id: unknown, what: string): Stream {
    this.assertOpen();
    const s = typeof id === 'number' ? this.streams.get(id) : undefined;
    if (!s) throw new Error(`${what}: no open stream ${String(id)}`);
    if (s.upgrading) throw new Error(`${what}: the TLS handshake is running`);
    return s;
  }

  /** Up to `max` bytes, waiting for some; null once the peer closed and all was read. */
  async read(id: unknown, max?: unknown): Promise<Uint8Array | null> {
    const s = this.get(id, 'tcp.read');
    const limit =
      typeof max === 'number' && Number.isInteger(max) && max > 0
        ? Math.min(max, TCP_LIMITS.readChunk)
        : TCP_LIMITS.readChunk;
    while (s.size === 0 && !s.ended && !s.error) {
      if (s.wake) throw new Error('tcp.read: a read on this stream is already waiting');
      await new Promise<void>((r) => {
        s.wake = r;
      });
    }
    if (s.size === 0) {
      if (s.error) throw s.error;
      return null;
    }
    const all = s.chunks.length === 1 ? s.chunks[0]! : Buffer.concat(s.chunks);
    const out = all.subarray(0, limit);
    const rest = all.subarray(limit);
    s.chunks = rest.length > 0 ? [rest] : [];
    s.size = rest.length;
    if (s.size < TCP_LIMITS.buffered && s.socket.isPaused()) s.socket.resume();
    return new Uint8Array(out);
  }

  async write(id: unknown, data: Uint8Array): Promise<void> {
    const s = this.get(id, 'tcp.write');
    if (s.error) throw s.error;
    if (s.ended) throw new Error('tcp.write: the stream is closed');
    const over = this.count(data.length);
    if (over) throw over;
    await new Promise<void>((resolve, reject) =>
      s.socket.write(data, (err) => (err ? reject(err) : resolve())),
    );
  }

  /**
   * Upgrades a `starttls` stream once the job's protocol said so (IMAP
   * `STARTTLS`, SMTP `STARTTLS`). Refused while any of the peer's plaintext is
   * unread, buffered here or still in the socket: bytes that arrived before
   * the handshake would otherwise be read as if they came over TLS (the
   * STARTTLS command-injection class). Until the handshake ends, the stream
   * refuses reads and writes, so nothing meant for TLS goes out in clear.
   */
  async startTls(id: unknown): Promise<void> {
    const s = this.get(id, 'tcp.startTls');
    if (s.target.tls !== 'starttls') {
      throw new Error('tcp.startTls: the stream was not opened starttls');
    }
    if (s.secure) throw new Error('tcp.startTls: TLS is already up');
    if (s.wake) throw new Error('tcp.startTls: a read on this stream is waiting');
    const plain = s.socket;
    if (s.size > 0 || plain.readableLength > 0) {
      this.kill(s, new Error('tcp.startTls: the server sent data before the TLS handshake'));
      throw s.error;
    }
    s.upgrading = true;
    plain.removeAllListeners('data');
    plain.removeAllListeners('end');
    plain.removeAllListeners('close');
    plain.removeAllListeners('timeout');
    plain.removeAllListeners('error');
    plain.setTimeout(0);
    // The raw socket keeps an error listener: an unhandled one would crash the engine.
    plain.on('error', (err) => this.kill(s, err));
    try {
      s.socket = await new Promise<TLSSocket>((resolve, reject) => {
        const t = tlsConnect({ ...this.tlsOptions(s.name), socket: plain });
        const timer = setTimeout(() => {
          t.destroy();
          reject(new Error('[egress] the TLS handshake timed out'));
        }, TCP_LIMITS.connectMs);
        t.once('error', (err) => {
          clearTimeout(timer);
          t.destroy();
          reject(err);
        });
        t.once('secureConnect', () => {
          clearTimeout(timer);
          t.removeAllListeners('error');
          resolve(t);
        });
      });
    } catch (err) {
      s.upgrading = false;
      this.kill(s, err as Error);
      throw err;
    }
    s.upgrading = false;
    s.secure = true;
    this.attach(s);
    if (this.closed) s.socket.destroy();
  }

  close(id: unknown): void {
    const s = this.get(id, 'tcp.close');
    s.socket.destroy();
    this.streams.delete(id as number);
  }

  closeAll(): void {
    this.closed = true;
    for (const s of this.streams.values()) s.socket.destroy();
    this.streams.clear();
  }
}

/** `p`, or a timeout error after the connect deadline. */
function deadline<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`[egress] ${what} timed out`)),
        TCP_LIMITS.connectMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
