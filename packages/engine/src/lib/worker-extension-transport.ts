/**
 * Byte-stream transport for worker-isolated (third-party) extensions (RFC
 * extension-runner, steps 2 and 9).
 *
 * The protocol (worker-extension-protocol.ts) is the messages; this is how they
 * cross. A frame is a 4-byte big-endian length followed by that many bytes of
 * UTF-8 JSON. The runtime is a process whose stdin carries the host's frames and
 * whose stdout carries its own — pipes created at spawn and inherited by that
 * child only, so the channel itself is the identity: every frame read from it is
 * the extension the process was spawned for.
 *
 * Two transports, both a process (RFC step 9 removed the in-thread worker):
 * `runner`, the production default, hands the frames to the extension runner,
 * which runs the extension under a uid of its own; `process`, the default
 * outside production, spawns the runtime as the engine's own child — the same
 * protocol, under the engine's uid, so no boundary.
 */

import { connect } from 'node:net';
import type { HostToWorkerMessage, WorkerToHostMessage } from './worker-extension-protocol.js';

/**
 * Largest frame either side accepts. A frame carries a whole request or
 * response body, as `postMessage` did; past this the channel ends instead of
 * buffering without bound.
 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(msg: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(msg));
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`frame of ${body.length} bytes exceeds ${MAX_FRAME_BYTES}`);
  }
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

/**
 * Reassembles frames from arbitrary chunks. Throws on an oversized or
 * malformed frame: the peer is broken or hostile, and the caller ends the
 * channel. The buffer grows by doubling, so a large frame arriving in small
 * chunks costs linear copying, not quadratic.
 */
export class FrameDecoder {
  private buf = new Uint8Array(64 * 1024);
  private len = 0;

  push(chunk: Uint8Array): unknown[] {
    if (this.len + chunk.length > this.buf.length) {
      let cap = this.buf.length;
      while (cap < this.len + chunk.length) cap *= 2;
      const grown = new Uint8Array(cap);
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;

    const out: unknown[] = [];
    let at = 0;
    while (this.len - at >= 4) {
      const size = new DataView(this.buf.buffer, at, 4).getUint32(0);
      if (size > MAX_FRAME_BYTES) {
        throw new Error(`frame of ${size} bytes exceeds ${MAX_FRAME_BYTES}`);
      }
      if (this.len - at - 4 < size) break;
      out.push(JSON.parse(decoder.decode(this.buf.subarray(at + 4, at + 4 + size))));
      at += 4 + size;
    }
    this.buf.copyWithin(0, at, this.len);
    this.len -= at;
    return out;
  }
}

/**
 * What the host holds for a running extension, whichever process runs it. Shaped
 * like a `Worker` because the in-thread worker was the first implementation.
 */
export interface ExtensionChannel {
  postMessage(msg: HostToWorkerMessage): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<WorkerToHostMessage>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

export type ExtensionTransport = 'process' | 'runner';

/**
 * `ZVELTIO_EXT_TRANSPORT` when it names a transport, else the runner in
 * production and a local child everywhere else. Production never picks `process`
 * on its own: an operator who sets it is refused at load
 * (`enforceRunnerInProduction`), never served without a boundary.
 */
export function extensionTransport(
  env: Record<string, string | undefined> = process.env,
): ExtensionTransport {
  const t = env.ZVELTIO_EXT_TRANSPORT;
  if (t === 'process' || t === 'runner') return t;
  return env.NODE_ENV === 'production' ? 'runner' : 'process';
}

/**
 * The host side of a frame channel over any byte stream: frames out through
 * `send`, frames in from `chunks`. The end of `chunks`, or a frame the decoder
 * refuses, is reported once through `onerror` — the host's respawn path, as
 * for a crashed worker.
 */
function frameChannel(
  send: (bytes: Uint8Array) => void,
  kill: () => void,
  chunks: AsyncIterable<Uint8Array>,
  endReason: () => Promise<string>,
): ExtensionChannel {
  let ended = false;
  const channel: ExtensionChannel = {
    onmessage: null,
    onerror: null,
    postMessage(msg) {
      if (!ended) send(encodeFrame(msg));
    },
    terminate() {
      ended = true;
      kill();
    },
  };
  const fail = (message: string) => {
    if (ended) return;
    ended = true;
    kill();
    channel.onerror?.(new ErrorEvent('error', { message }));
  };
  void (async () => {
    const frames = new FrameDecoder();
    try {
      for await (const chunk of chunks) {
        for (const data of frames.push(chunk)) {
          channel.onmessage?.(new MessageEvent('message', { data: data as WorkerToHostMessage }));
        }
      }
    } catch (err) {
      fail(`runner channel: ${(err as Error).message}`);
      return;
    }
    fail(await endReason());
  })();
  return channel;
}

/**
 * Spawn the runtime as a child process speaking frames on stdin/stdout.
 *
 * `env` REPLACES the environment: none of the engine's variables reach it. Run with
 * the engine's own executable: under a `bun build --compile` binary that is
 * the engine, and `BUN_BE_BUN` makes it act as `bun`. stderr is inherited, so
 * what the runtime cannot forward as a `log` frame still reaches the journal.
 */
export function spawnProcessRunner(
  runtimePath: string,
  env: Record<string, string>,
): ExtensionChannel {
  const proc = Bun.spawn([process.execPath, runtimePath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...env, BUN_BE_BUN: '1' },
  });
  return frameChannel(
    (bytes) => {
      proc.stdin.write(bytes);
      proc.stdin.flush();
    },
    () => proc.kill(),
    proc.stdout,
    async () => `runner exited with code ${await proc.exited}`,
  );
}

/**
 * Connect to an extension's runner (RFC step 3, lib/ext-runner.ts). The
 * runner spawns the runtime under its own uid when the connection is
 * accepted; the connection is the channel, so the identity rule is the same
 * as for a spawned child. The engine sends no environment: the runner starts
 * the runtime with its own minimal one.
 */
export function connectRunner(socketPath: string): ExtensionChannel {
  const sock = connect(socketPath);
  let reason = 'runner closed the connection';
  sock.on('error', (err) => {
    reason = `runner socket ${socketPath}: ${err.message}`;
  });
  return frameChannel(
    (bytes) => {
      sock.write(bytes);
    },
    () => sock.destroy(),
    sock,
    async () => reason,
  );
}
