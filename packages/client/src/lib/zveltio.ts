import { ZveltioClient } from '@zveltio/sdk';
import { SyncManager } from '@zveltio/sdk';
import { stepUp } from './step-up.svelte.js';

const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

// A step-up the engine asks for opens the dialog; a cancel rejects the call.
export const client = new ZveltioClient({
  baseUrl: ENGINE_URL,
  onStepUpRequired: (action) => stepUp.token(action),
});

export const sync = new SyncManager(client, {
  syncInterval: 5000,
  maxRetries: 5,
  onConflict: (_local, server) => server, // Server wins by default
});

/**
 * Initializeaza SDK-ul — apelat o singura data din +layout.ts (browser-only).
 * Porneste SyncManager + WebSocket realtime.
 */
export async function initZveltio(): Promise<void> {
  await sync.start(ENGINE_URL);
}
