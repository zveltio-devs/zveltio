/**
 * Byte-stream transport for worker-isolated extensions (RFC extension-runner,
 * step 2).
 *
 * The protocol (worker-extension-protocol.ts) is unchanged; only how a message
 * crosses changes. A frame is a 4-byte big-endian length followed by that many
 * bytes of UTF-8 JSON. The runner is a child process whose stdin carries the
 * host's frames and whose stdout carries its own — pipes created at spawn and
 * inherited by that child only, so the channel itself is the identity: every
 * frame read from it is the extension the runner was spawned for.
 *
 * `ZVELTIO_EXT_TRANSPORT=process` selects it; the in-thread worker stays the
 * default (and the development transport) until the runner is the default
 * (RFC step 6). This step changes the transport, not the isolation: the child
 * still runs under the engine's uid (step 3 gives it its own).
 */

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
 * What the host holds for a running extension: the surface of a `Worker` it
 * uses, so the in-thread worker and the runner process are interchangeable.
 */
export interface ExtensionChannel {
  postMessage(msg: HostToWorkerMessage): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<WorkerToHostMessage>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

export type ExtensionTransport = 'worker' | 'process';

export function extensionTransport(): ExtensionTransport {
  return process.env.ZVELTIO_EXT_TRANSPORT === 'process' ? 'process' : 'worker';
}

/**
 * Spawn the runtime as a child process speaking frames on stdin/stdout.
 *
 * `env` REPLACES the environment, as the worker's `env` option does. Run with
 * the engine's own executable: under a `bun build --compile` binary that is
 * the engine, and `BUN_BE_BUN` makes it act as `bun`. stderr is inherited, so
 * what the runtime cannot forward as a `log` frame still reaches the journal.
 * An exit, or a frame the decoder refuses, is reported once through `onerror`
 * — the host's respawn path, as for a crashed worker.
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
  let ended = false;
  const channel: ExtensionChannel = {
    onmessage: null,
    onerror: null,
    postMessage(msg) {
      if (ended) return;
      proc.stdin.write(encodeFrame(msg));
      proc.stdin.flush();
    },
    terminate() {
      ended = true;
      proc.kill();
    },
  };
  const fail = (message: string) => {
    if (ended) return;
    ended = true;
    proc.kill();
    channel.onerror?.(new ErrorEvent('error', { message }));
  };
  void (async () => {
    const frames = new FrameDecoder();
    try {
      for await (const chunk of proc.stdout) {
        for (const data of frames.push(chunk)) {
          channel.onmessage?.(new MessageEvent('message', { data: data as WorkerToHostMessage }));
        }
      }
    } catch (err) {
      fail(`runner channel: ${(err as Error).message}`);
      return;
    }
    fail(`runner exited with code ${await proc.exited}`);
  })();
  return channel;
}
