/**
 * The sandbox bridge against the origin its own iframe actually has.
 *
 * The iframe carries no `allow-same-origin`, so its document has an opaque
 * origin and every message it sends arrives with `event.origin === 'null'`.
 * The host compared that against the bundle's origin, so no message from the
 * frame was ever accepted — `ready` included, which is the whole handshake.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import MarketplaceSandbox from './MarketplaceSandbox.svelte';

afterEach(cleanup);

function mount() {
  const onNavigate = vi.fn();
  const { container } = render(MarketplaceSandbox, {
    props: {
      src: 'http://localhost:3000/ext/demo/index.html',
      extensionId: 'demo',
      enabled: true,
      onNavigate,
    },
  });
  const frame = container.querySelector('iframe') as HTMLIFrameElement;
  return { frame, container, onNavigate };
}

function send(frame: HTMLIFrameElement, origin: string, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { origin, data, source: frame.contentWindow }));
}

describe('MarketplaceSandbox', () => {
  it('accepts the opaque-origin handshake from its own frame', async () => {
    const { frame, container } = mount();
    send(frame, 'null', { type: 'zveltio:marketplace:ready' });
    await Promise.resolve();
    expect(
      container.querySelector('[data-testid="marketplace-sandbox"]')?.getAttribute('data-ready'),
    ).toBe('1');
  });

  it('routes a navigate message from its own frame', async () => {
    const { frame, onNavigate } = mount();
    send(frame, 'null', { type: 'zveltio:marketplace:navigate', path: '/admin/demo' });
    expect(onNavigate).toHaveBeenCalledWith('/admin/demo');
  });

  it('ignores a message from any other window', async () => {
    const { frame, onNavigate, container } = mount();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'null',
        data: { type: 'zveltio:marketplace:navigate', path: '/admin/evil' },
        source: window,
      }),
    );
    expect(onNavigate).not.toHaveBeenCalled();
    send(frame, 'https://evil.example', { type: 'zveltio:marketplace:ready' });
    expect(
      container.querySelector('[data-testid="marketplace-sandbox"]')?.getAttribute('data-ready'),
    ).toBe('0');
  });
});
