/**
 * Post-write event bus (lib/runtime/event-bus.ts) — emit/on/off/once/listenerCount.
 */

import { describe, expect, it } from 'bun:test';
import { engineEvents } from '../../lib/runtime/event-bus.js';

describe('engineEvents post-write API', () => {
  it('delivers payloads to on() subscribers and supports off()', () => {
    const seen: string[] = [];
    const handler = (p: { userId: string }) => seen.push(p.userId);
    engineEvents.on('user.login', handler);
    engineEvents.emit('user.login', { userId: 'u-1', ip: '127.0.0.1' });
    expect(seen).toEqual(['u-1']);
    engineEvents.off('user.login', handler);
    engineEvents.emit('user.login', { userId: 'u-2', ip: '127.0.0.1' });
    expect(seen).toEqual(['u-1']);
  });

  it('once() fires at most one delivery', () => {
    let n = 0;
    engineEvents.once('user.logout', () => {
      n++;
    });
    engineEvents.emit('user.logout', { userId: 'u-1' });
    engineEvents.emit('user.logout', { userId: 'u-1' });
    expect(n).toBe(1);
  });

  it('listenerCount tracks active handlers', () => {
    const h = () => {};
    const unsub = engineEvents.on('schema.changed', h);
    expect(engineEvents.listenerCount('schema.changed')).toBeGreaterThanOrEqual(1);
    unsub();
    engineEvents.off('schema.changed', h);
  });

  it('emits flow.completed and ai.task.done payloads', () => {
    const flows: string[] = [];
    const ai: boolean[] = [];
    const u1 = engineEvents.on('flow.completed', (p) => flows.push(p.flowId));
    const u2 = engineEvents.on('ai.task.done', (p) => ai.push(p.notified));
    try {
      engineEvents.emit('flow.completed', { flowId: 'f-1', status: 'success' });
      engineEvents.emit('ai.task.done', { userId: 'u-1', summary: 'done', notified: true });
      expect(flows).toContain('f-1');
      expect(ai).toContain(true);
    } finally {
      u1();
      u2();
    }
  });
});
