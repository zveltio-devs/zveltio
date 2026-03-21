import { ZveltioClient } from '@zveltio/sdk';
import { SyncManager } from '@zveltio/sdk';

const ENGINE_URL = import.meta.env.PUBLIC_ENGINE_URL || 'http://localhost:3000';

export const client = new ZveltioClient({ baseUrl: ENGINE_URL });

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
  await sync.start(`${ENGINE_URL}/api/ws`);
}
