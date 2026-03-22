# @zveltio/sdk

TypeScript SDK for Zveltio — HTTP client, Realtime WebSocket, and Local-First offline support.

## Installation

```bash
bun add @zveltio/sdk
```

## Basic Usage

```typescript
import { createZveltioClient } from '@zveltio/sdk';

const client = createZveltioClient({ baseUrl: 'https://api.myapp.com' });

// CRUD
const todos = await client.collection('todos').list();
await client.collection('todos').create({ title: 'Buy milk', done: false });
await client.collection('todos').update('id-123', { done: true });
await client.collection('todos').delete('id-123');
```

## Live TypeScript Types

Get full IntelliSense on every `.collection()` call by pointing the client at your generated schema.

**Step 1 — Generate types** (one-shot or watch mode):

```bash
# One-shot
bunx zveltio generate-types --url http://localhost:3000 --out ./src/zveltio-types.d.ts

# Watch mode (re-generates on every schema change while developing)
bunx zveltio dev --watch
```

**Step 2 — Import the generated alias:**

```typescript
import type { ZveltioSchema } from './zveltio-types';
```

**Step 3 — Pass it to `createZveltioClient`:**

```typescript
import { createZveltioClient } from '@zveltio/sdk';
import type { ZveltioSchema } from './zveltio-types';

const client = createZveltioClient<ZveltioSchema>({
  baseUrl: 'https://api.myapp.com',
});
```

**Step 4 — Every `.collection()` call is now fully typed:**

```typescript
// TypeScript knows the shape of each record automatically
const { data: products } = await client.collection('products').list();
//           ^-- typed as Products[] (from your generated CollectionTypeMap)

const order = await client.collection('orders').getOne('ord-123');
//    ^-- typed as Orders

await client.collection('products').create({ name: 'Widget', price: 9.99 });
//   TypeScript will error if you pass unknown fields or the wrong types
```

The generated file (`zveltio-types.d.ts`) exports individual interfaces per collection, a `CollectionTypeMap` interface, and the `ZveltioSchema` alias — all kept in sync automatically when you run in watch mode.

## Realtime

```typescript
import { ZveltioRealtime } from '@zveltio/sdk';

const rt = new ZveltioRealtime('https://api.myapp.com');
rt.connect();

const unsub = rt.subscribe('todos', (event) => {
  console.log('Event:', event.event, event.record_id);
});

// Cleanup
unsub();
rt.disconnect();
```

## Local-First Usage

Zveltio SDK supports offline-first data access with automatic background sync:

```typescript
import { createZveltioClient, SyncManager } from '@zveltio/sdk';

const client = createZveltioClient({ baseUrl: 'https://api.myapp.com' });
const sync = new SyncManager(client, {
  syncInterval: 5000,
  onConflict: (local, server) => {
    // Custom merge: keep local 'notes' field, take rest from server
    return { ...server, notes: local?.notes };
  },
});

// Start: opens IndexedDB, connects WebSocket, starts periodic sync
await sync.start('https://api.myapp.com');

// All operations are instant (local-first)
const todos = sync.collection('todos');

// Create — writes locally, syncs in background
await todos.create({ title: 'Buy milk', done: false });

// List — reads from local IndexedDB (instant, works offline)
const all = await todos.list();
// each record has _syncStatus: 'synced' | 'pending' | 'conflict'

// Update — writes locally, syncs in background
await todos.update('id-123', { done: true });

// Delete — soft-deletes locally, syncs in background
await todos.delete('id-123');

// Subscribe — reactive updates (local writes + server push via WebSocket)
const unsub = todos.subscribe((records) => {
  console.log('Todos updated:', records);
});

// Check sync status
const status = await sync.getStatus();
// { pending: 2, conflicts: 0, isOnline: true }

// Handle conflicts manually
const conflicts = await todos.getConflicts();
for (const conflict of conflicts) {
  await todos.resolveConflict(conflict.id, { ...conflict.data, resolved: true });
}

// Cleanup
unsub();
await sync.stop();
```

## Svelte 5 Integration

```svelte
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { useSyncCollection, useSyncStatus } from '@zveltio/sdk';

  let todos = $state<any[]>([]);
  let syncStatus = $state({ pending: 0, conflicts: 0, isOnline: true });

  const unsubTodos = useSyncCollection(sync, 'todos', (records) => {
    todos = records;
  });

  const unsubStatus = useSyncStatus(sync, (s) => {
    syncStatus = s;
  });

  onDestroy(() => {
    unsubTodos();
    unsubStatus();
  });
</script>

{#if !syncStatus.isOnline}
  <div class="alert alert-warning">Offline — changes will sync when reconnected</div>
{/if}

{#if syncStatus.pending > 0}
  <div class="badge badge-warning">{syncStatus.pending} pending</div>
{/if}

{#each todos as todo}
  <div class:opacity-60={todo._syncStatus === 'pending'}>
    {todo.title}
    {#if todo._syncStatus === 'conflict'}<span class="badge badge-error">conflict</span>{/if}
  </div>
{/each}
```

## Engine Sync Endpoints

The engine exposes two endpoints for batch sync:

- `POST /api/sync/push` — send offline operations to server
- `POST /api/sync/pull` — pull changes since a timestamp

These are used automatically by `SyncManager`. You can also call them directly for custom sync logic.
