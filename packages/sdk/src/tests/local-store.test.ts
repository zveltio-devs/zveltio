import './setup';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { LocalStore } from '../local-store.js';

describe('LocalStore — conflict detection', () => {
  let store: LocalStore;

  beforeEach(async () => {
    store = new LocalStore();
    await store.open();
    // Reset DB state — fake-indexeddb is a module-level singleton shared across
    // test files within the same Bun process (src/ and dist/ runs both use it).
    // Without clearing, dist/ tests find records left by src/ tests and
    // _localVersion is wrong (e.g. 2 instead of 1 for a fresh put).
    await store.clear();
  });

  afterEach(async () => {
    await store.close();
  });

  it('no conflict when record is clean (no local edits)', async () => {
    // Simulate a record that arrived from server with no local edits
    await store.applyServerUpdate('posts', 'rec-1', { title: 'Hello' }, 1);
    const rec = await store.get('posts', 'rec-1');
    expect(rec?._syncStatus).toBe('synced');
    expect(rec?._conflictData).toBeUndefined();
  });

  it('detects conflict when server update races a pending local write', async () => {
    // 1. Client writes locally (status=pending, localVersion=1, serverVersion=0)
    await store.put('posts', 'rec-2', { title: 'Draft' });
    const before = await store.get('posts', 'rec-2');
    expect(before?._syncStatus).toBe('pending');
    expect(before?._localVersion).toBe(1);
    expect(before?._serverVersion).toBe(0);

    // 2. Server pushes an update
    await store.applyServerUpdate('posts', 'rec-2', { title: 'Server Title' }, 3);

    const after = await store.get('posts', 'rec-2');
    expect(after?._syncStatus).toBe('conflict');
    expect(after?._conflictData).toEqual({ title: 'Server Title' });
    // Local data is NOT overwritten so user can compare both versions
    expect(after?.data).toEqual({ title: 'Draft' });
  });

  it('detects conflict when localVersion > serverVersion regardless of syncStatus (CLAUDE.md scenario)', async () => {
    // Reproduce: _localVersion=2, _serverVersion=1, _syncStatus='synced'
    // Step 1: server sends version 1 → _localVersion=0, _serverVersion=1
    await store.applyServerUpdate('posts', 'rec-3', { title: 'Original' }, 1);

    // Step 2: two local edits → _localVersion=2, _serverVersion=1
    await store.put('posts', 'rec-3', { title: 'Edit 1' }); // localVersion=1
    await store.put('posts', 'rec-3', { title: 'Edit 2' }); // localVersion=2

    // Step 3: forcibly mark as 'synced' while localVersion(2) > serverVersion(1)
    // (simulate the race: sync ACK arrived for v1 but client already at v2)
    const pending = await store.get('posts', 'rec-3');
    expect(pending?._localVersion).toBe(2);
    expect(pending?._serverVersion).toBe(1);

    // Patch syncStatus to 'synced' without advancing serverVersion — the race condition
    const queueItems = await store.getPendingOps();
    // Use markSynced for the first op only — server confirmed v1, client is at v2
    if (queueItems[0]) {
      await store.markSynced(queueItems[0].id, 'posts', 'rec-3', 1);
    }

    const raceState = await store.get('posts', 'rec-3');
    // After markSynced: _serverVersion=1, _localVersion=2 → still dirty
    expect(raceState?._localVersion).toBeGreaterThan(raceState?._serverVersion ?? 0);

    // Step 4: server pushes a concurrent update
    await store.applyServerUpdate('posts', 'rec-3', { title: 'Concurrent Server Edit' }, 5);

    const conflict = await store.get('posts', 'rec-3');
    expect(conflict?._syncStatus).toBe('conflict');
    expect(conflict?._conflictData).toEqual({ title: 'Concurrent Server Edit' });
  });

  it('applies cleanly when server version is newer and no local edits', async () => {
    await store.applyServerUpdate('posts', 'rec-4', { title: 'v1' }, 1);
    await store.applyServerUpdate('posts', 'rec-4', { title: 'v2' }, 2);

    const rec = await store.get('posts', 'rec-4');
    expect(rec?._syncStatus).toBe('synced');
    expect(rec?.data).toEqual({ title: 'v2' });
    expect(rec?._serverVersion).toBe(2);
    expect(rec?._conflictData).toBeUndefined();
  });
});
