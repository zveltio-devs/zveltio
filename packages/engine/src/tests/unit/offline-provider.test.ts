import { describe, it, expect } from 'bun:test';
import {
  createOfflineProvider,
  ElectricNotConfigured,
} from '@zveltio/sdk/offline';

/**
 * S5-07 — offline-sync provider factory.
 *
 * Today: only the `crdt` provider has a runtime path. `electric` is a
 * stub that throws on every operation so apps can compile and choose
 * the strategy at construction time, then migrate to the real Electric
 * impl in a follow-up wave without rewriting their data layer.
 */

describe('S5-07 createOfflineProvider — crdt path', () => {
  it('builds a working stub for the default crdt provider', async () => {
    const p = await createOfflineProvider({ engineUrl: 'http://localhost:3000' });
    expect(p.kind).toBe('crdt');
    expect(typeof p.pull).toBe('function');
    expect(typeof p.push).toBe('function');
    expect(typeof p.subscribe).toBe('function');
    expect(typeof p.close).toBe('function');
  });

  it('pull/push/subscribe/close all callable without throw on the CRDT shim', async () => {
    const p = await createOfflineProvider({ engineUrl: 'http://localhost:3000' });
    await expect(p.pull()).resolves.toBeUndefined();
    await expect(p.push()).resolves.toBe(0);
    const off = p.subscribe('zvd_contacts', () => { /* */ });
    expect(typeof off).toBe('function');
    off();
    await expect(p.close()).resolves.toBeUndefined();
  });
});

describe('S5-07 createOfflineProvider — electric stub', () => {
  it('throws ElectricNotConfigured when electricUrl is missing', async () => {
    let caught: Error | null = null;
    try {
      await createOfflineProvider({
        engineUrl: 'http://localhost:3000',
        provider: 'electric',
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(ElectricNotConfigured);
    expect(caught?.message).toContain('electricUrl is required');
  });

  it('builds an electric provider that throws on every op', async () => {
    const p = await createOfflineProvider({
      engineUrl: 'http://localhost:3000',
      provider: 'electric',
      electricUrl: 'https://electric.example.com',
    });
    expect(p.kind).toBe('electric');
    await expect(p.pull()).rejects.toBeInstanceOf(ElectricNotConfigured);
    await expect(p.push()).rejects.toBeInstanceOf(ElectricNotConfigured);
    expect(() => p.subscribe('zvd_x', () => { /* */ })).toThrow(ElectricNotConfigured);
    await expect(p.close()).resolves.toBeUndefined();
  });

  it('error messages point at the migration path (mention crdt as the working alternative)', async () => {
    let caught: Error | null = null;
    try {
      const p = await createOfflineProvider({
        engineUrl: 'http://localhost:3000',
        provider: 'electric',
        electricUrl: 'https://electric.example.com',
      });
      await p.pull();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message.toLowerCase()).toContain('crdt');
  });
});
