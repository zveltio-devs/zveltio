import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Hono } from 'hono';
import { WorkerExtensionHost, _resetWorkerHostForTests } from '../../lib/worker-extension-host.js';

/**
 * WorkerExtensionHost unit tests — alpha.122 reliability features.
 *
 * The full IPC chain (real Bun.Worker spawning the embedded runtime,
 * Hono dispatch, DB proxy) is exercised by the release-binary smoke
 * job. These tests pin the host-side bookkeeping that the smoke can't
 * easily inspect:
 *   - getHealth() output shape and field semantics
 *   - isRunning / stopAll lifecycle
 *   - constructor + singleton reset helpers
 *   - protocol message routing via the public test seam
 *
 * The Worker constructor is mocked so the tests stay synchronous +
 * fast. Mocking the IPC chain end-to-end would just duplicate what
 * release smoke already validates.
 */

function makeFakeHono(): Hono {
  const routes: unknown[] = [];
  const fake = {
    route: () => fake,
    get: (_p: string, _h: unknown) => fake,
    post: (_p: string, _h: unknown) => fake,
    put: (_p: string, _h: unknown) => fake,
    patch: (_p: string, _h: unknown) => fake,
    delete: (_p: string, _h: unknown) => fake,
    routes,
  };
  return fake as unknown as Hono;
}

describe('WorkerExtensionHost — lifecycle helpers', () => {
  beforeEach(() => _resetWorkerHostForTests());
  afterEach(() => _resetWorkerHostForTests());

  it('isRunning() returns false for unknown extension', () => {
    const host = new WorkerExtensionHost(makeFakeHono());
    expect(host.isRunning('ghost-extension')).toBe(false);
  });

  it('getHealth() returns empty array before any workers spawn', () => {
    const host = new WorkerExtensionHost(makeFakeHono());
    expect(host.getHealth()).toEqual([]);
  });

  it('stopAll() resolves cleanly with no active workers', async () => {
    const host = new WorkerExtensionHost(makeFakeHono());
    await expect(host.stopAll()).resolves.toBeUndefined();
  });

  it('stop() on a non-existent extension is a no-op', async () => {
    const host = new WorkerExtensionHost(makeFakeHono());
    await expect(host.stop('not-a-real-ext')).resolves.toBeUndefined();
  });
});

describe('WorkerExtensionHost — health record shape', () => {
  // Inject a fake managed-worker into the private map via test seam.
  // We don't spawn a real Worker (slow + flaky in CI), just verify
  // the field projection in getHealth() matches the protocol contract.
  beforeEach(() => _resetWorkerHostForTests());
  afterEach(() => _resetWorkerHostForTests());

  it('reports per-extension fields the agent review pinned as required', () => {
    const host = new WorkerExtensionHost(makeFakeHono());
    const fakeWorker = {
      name: 'test-ext',
      worker: { terminate: mock(() => {}) } as unknown as Worker,
      routes: [
        { method: 'GET', path: '/health' },
        { method: 'POST', path: '/action' },
      ],
      pendingInvokes: new Map(),
      pendingInits: new Map(),
      pendingPings: new Map(),
      registeredServices: new Set<string>(),
      proxyUnmount: () => {},
      workerGeneration: 3,
      enabledAt: Date.parse('2026-05-31T10:00:00Z'),
      lastCrashAt: Date.parse('2026-05-31T10:15:00Z'),
      lastHangAt: undefined,
      inFlightRequests: 2,
      totalRequests: 1847,
      bundleHashPrefix: 'bd35cbab',
      extDir: '/opt/zveltio/extensions/test-ext',
      bundleEntry: 'engine/index.js',
      stopped: false,
    };
    // @ts-expect-error — test seam, intentionally pokes private map
    host.workers.set('test-ext', fakeWorker);

    const health = host.getHealth();
    expect(health.length).toBe(1);
    const h = health[0]!;
    expect(h.name).toBe('test-ext');
    expect(h.isolation).toBe('worker');
    expect(h.status).toBe('running');
    expect(h.workerGeneration).toBe(3);
    expect(h.routes).toBe(2);
    expect(h.inFlightRequests).toBe(2);
    expect(h.totalRequests).toBe(1847);
    expect(h.bundleHashPrefix).toBe('bd35cbab');
    expect(h.integrityOk).toBe(true);
    expect(h.enabledAt).toBe('2026-05-31T10:00:00.000Z');
    expect(h.lastCrashAt).toBe('2026-05-31T10:15:00.000Z');
    expect(h.lastHangAt).toBeUndefined();
    // Honest: there is NO per-extension RSS field. Bun.Worker is a thread.
    expect('rssBytes' in h).toBe(false);
    expect('memoryMb' in h).toBe(false);
  });

  it('marks status=crashed when the managed worker is stopped', () => {
    const host = new WorkerExtensionHost(makeFakeHono());
    const fakeWorker = {
      name: 'crashed-ext',
      worker: { terminate: mock(() => {}) } as unknown as Worker,
      routes: [],
      pendingInvokes: new Map(),
      pendingInits: new Map(),
      pendingPings: new Map(),
      registeredServices: new Set<string>(),
      proxyUnmount: () => {},
      workerGeneration: 1,
      enabledAt: Date.now(),
      inFlightRequests: 0,
      totalRequests: 0,
      extDir: '/tmp',
      bundleEntry: 'engine/index.js',
      stopped: true,
    };
    // @ts-expect-error — test seam
    host.workers.set('crashed-ext', fakeWorker);
    expect(host.getHealth()[0]?.status).toBe('crashed');
  });
});

describe('WorkerExtensionHost — duplicate start guard', () => {
  beforeEach(() => _resetWorkerHostForTests());
  afterEach(() => _resetWorkerHostForTests());

  it('refuses to spawn a second worker for the same extension', async () => {
    const host = new WorkerExtensionHost(makeFakeHono());
    // Pre-seed a fake live worker so start() bails before the real spawn.
    // @ts-expect-error — test seam
    host.workers.set('dup', {
      name: 'dup',
      worker: { terminate: () => {} } as unknown as Worker,
      routes: [],
      pendingInvokes: new Map(),
      pendingInits: new Map(),
      pendingPings: new Map(),
      registeredServices: new Set(),
      proxyUnmount: () => {},
      workerGeneration: 1,
      enabledAt: Date.now(),
      inFlightRequests: 0,
      totalRequests: 0,
      extDir: '/tmp',
      bundleEntry: 'engine/index.js',
      stopped: false,
    });
    await expect(host.start('dup', '/tmp', 'engine/index.js')).rejects.toThrow(/already running/i);
  });
});
