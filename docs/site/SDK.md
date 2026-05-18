# 📦 Zveltio SDK

Complete reference for all three Zveltio client packages.

---

## Table of Contents

- [Overview](#overview)
- [@zveltio/sdk — Base Client](#zveltiosdk--base-client)
- [@zveltio/sdk-react — React Hooks](#zveltiosdk-react--react-hooks)
- [@zveltio/sdk-vue — Vue Composables](#zveltiosdk-vue--vue-composables)
- [Local-First & Offline Sync](#local-first--offline-sync)
- [Real-Time WebSocket](#real-time-websocket)

---

## Overview

| Package | Framework | Install |
|---------|-----------|---------|
| `@zveltio/sdk` | Vanilla JS / TypeScript / Svelte | `npm i @zveltio/sdk` |
| `@zveltio/sdk-react` | React 18+ | `npm i @zveltio/sdk-react` |
| `@zveltio/sdk-vue` | Vue 3.3+ | `npm i @zveltio/sdk-vue` |

`sdk-react` and `sdk-vue` depend on `@zveltio/sdk` as a direct dependency — you don't need to install the base package separately.

---

## @zveltio/sdk — Base Client

### Setup

```typescript
import { createZveltioClient } from '@zveltio/sdk';

const client = createZveltioClient({
  baseUrl: 'https://api.yourapp.com',
  apiKey: 'zvk_...', // optional — uses session cookie if omitted
});
```

### Configuration

```typescript
interface ZveltioClientConfig {
  baseUrl: string;             // Engine URL (no trailing slash)
  apiKey?: string;             // API key (X-API-Key header)
  headers?: Record<string, string>; // Additional headers
}
```

### Collection CRUD

```typescript
const posts = client.collection('posts');

// List with filters, sorting, pagination
const { records, pagination } = await posts.list({
  page: 1,
  limit: 20,
  sort: 'created_at',
  order: 'desc',
  search: 'zveltio',
  filter: {
    status: 'published',
    views: { gt: 100 },
  },
});

// Get single record
const post = await posts.get('uuid-here');

// Create
const newPost = await posts.create({ title: 'Hello', status: 'draft' });

// Update (partial)
const updated = await posts.update('uuid', { status: 'published' });

// Delete
await posts.delete('uuid');
```

#### Filter operators

| Operator | Example |
|----------|---------|
| Exact match | `{ status: 'active' }` |
| Not equal | `{ status: { neq: 'deleted' } }` |
| Greater than | `{ price: { gt: 100 } }` |
| Less than | `{ price: { lt: 500 } }` |
| Greater or equal | `{ age: { gte: 18 } }` |
| Less or equal | `{ age: { lte: 65 } }` |
| Contains (ilike) | `{ name: { like: 'john' } }` |
| In array | `{ status: { in: ['active', 'pending'] } }` |
| Not in array | `{ status: { not_in: ['deleted'] } }` |
| Is null | `{ deleted_at: { null: true } }` |
| Is not null | `{ published_at: { not_null: true } }` |

### Auth

```typescript
// Sign in
await client.auth.login('user@example.com', 'password');

// Sign up
await client.auth.signup('user@example.com', 'password', 'Full Name');

// Sign out
await client.auth.logout();

// Get current session
const session = await client.auth.session();
// { user: { id, email, name, role }, session: { ... } }
```

### Storage

```typescript
// Upload a file
const file = await client.storage.upload(fileInput.files[0], 'images/avatars');
// Returns: { id, filename, url, size, mime_type }

// List files
const { files } = await client.storage.list('images/avatars');

// Delete file
await client.storage.delete(file.id);
```

### Time Travel (Point-in-Time Queries)

```typescript
// List records as they were at a specific time
const { records, time_travel } = await client.get(
  '/api/data/orders?as_of=2025-12-31T23:59:59Z'
);

// Single record at a specific time
const { record, time_travel } = await client.get(
  '/api/data/orders/uuid?as_of=2025-12-31T23:59:59Z'
);
// time_travel: { as_of, snapshot_at }
```

### Raw HTTP

```typescript
// GET / POST / PATCH / DELETE
const result = await client.get('/api/collections');
const created = await client.post('/api/data/products', { name: 'Widget' });
const updated = await client.patch('/api/data/products/id', { price: 99 });
await client.delete('/api/data/products/id');

// File upload (multipart)
const fd = new FormData();
fd.append('file', file);
const result = await client.upload('/api/storage/upload', fd);
```

---

## @zveltio/sdk-react — React Hooks

### Setup

```tsx
import { createZveltioClient } from '@zveltio/sdk';
import { ZveltioProvider } from '@zveltio/sdk-react';

const client = createZveltioClient({ baseUrl: 'https://api.yourapp.com' });

function App() {
  return (
    <ZveltioProvider client={client}>
      <YourApp />
    </ZveltioProvider>
  );
}
```

### useCollection

```tsx
import { useCollection } from '@zveltio/sdk-react';

function PostsList() {
  const { data, loading, error, refetch } = useCollection('posts', {
    sort: 'created_at',
    order: 'desc',
    filter: { status: 'published' },
  });

  if (loading) return <Spinner />;
  if (error) return <Error message={error.message} />;

  return (
    <>
      {data?.map(post => <PostCard key={post.id} post={post} />)}
      <button onClick={refetch}>Refresh</button>
    </>
  );
}
```

### useRecord

```tsx
import { useRecord } from '@zveltio/sdk-react';

function PostDetail({ id }: { id: string }) {
  const { data: post, loading, error, refetch } = useRecord('posts', id);

  if (loading) return <Spinner />;
  if (!post) return <NotFound />;

  return <article>{post.title}</article>;
}
```

### useAuth

```tsx
import { useAuth } from '@zveltio/sdk-react';

function AuthButton() {
  const { data, loading, login, logout, signup } = useAuth();

  if (loading) return <Spinner />;

  if (!data?.user) {
    return (
      <button onClick={() => login('user@example.com', 'password')}>
        Sign In
      </button>
    );
  }

  return (
    <div>
      Welcome, {data.user.name}
      <button onClick={logout}>Sign Out</button>
    </div>
  );
}
```

### useStorage

```tsx
import { useStorage } from '@zveltio/sdk-react';

function FileUpload() {
  const { upload, list, remove, uploading, error } = useStorage();

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const result = await upload(file, 'avatars');
    console.log(result.url);
  };

  return (
    <>
      <input type="file" onChange={handleUpload} disabled={uploading} />
      {uploading && <span>Uploading...</span>}
      {error && <span>{error.message}</span>}
    </>
  );
}
```

### useRealtime

```tsx
import { useRealtime } from '@zveltio/sdk-react';

function LiveOrders() {
  const [orders, setOrders] = useState([]);

  useRealtime(
    'https://api.yourapp.com',
    'orders',
    'insert', // filter by event type, or null for all events
    (event) => {
      setOrders(prev => [event.data, ...prev]);
    }
  );

  return <OrderList orders={orders} />;
}
```

### useSyncCollection (Offline-First)

```tsx
import { useSyncCollection } from '@zveltio/sdk-react';

function OfflineNotes() {
  const { data, loading, error } = useSyncCollection('notes', {
    realtimeUrl: 'https://api.yourapp.com',
    syncInterval: 30000, // 30s background sync
  });

  return <NotesList notes={data ?? []} />;
}
```

---

## @zveltio/sdk-vue — Vue Composables

### Setup

```typescript
// main.ts
import { createApp } from 'vue';
import { createZveltioClient } from '@zveltio/sdk';
import { ZveltioPlugin } from '@zveltio/sdk-vue';
import App from './App.vue';

const client = createZveltioClient({ baseUrl: 'https://api.yourapp.com' });

createApp(App)
  .use(ZveltioPlugin, { client })
  .mount('#app');
```

### useCollection

```vue
<script setup lang="ts">
import { useCollection } from '@zveltio/sdk-vue';

const { data: posts, loading, error, refetch } = useCollection('posts', {
  sort: 'created_at',
  order: 'desc',
});
</script>

<template>
  <div v-if="loading">Loading...</div>
  <ul v-else>
    <li v-for="post in posts" :key="post.id">{{ post.title }}</li>
  </ul>
  <button @click="refetch">Refresh</button>
</template>
```

### useRecord

```vue
<script setup lang="ts">
import { useRecord } from '@zveltio/sdk-vue';

const props = defineProps<{ id: string }>();
const { data: post, loading, error } = useRecord('posts', props.id);
</script>
```

### useAuth

```vue
<script setup lang="ts">
import { useAuth } from '@zveltio/sdk-vue';

const { user, session, loading, login, logout, signup } = useAuth();
</script>

<template>
  <div v-if="loading">...</div>
  <button v-else-if="!user" @click="login('email', 'pass')">Sign In</button>
  <div v-else>
    Welcome {{ user.name }}
    <button @click="logout">Sign Out</button>
  </div>
</template>
```

### useStorage

```vue
<script setup lang="ts">
import { useStorage } from '@zveltio/sdk-vue';

const { upload, list, remove, uploading, error } = useStorage();

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) await upload(file, 'images');
}
</script>
```

### useRealtime

```vue
<script setup lang="ts">
import { useRealtime } from '@zveltio/sdk-vue';
import { ref } from 'vue';

const orders = ref<any[]>([]);

useRealtime(
  'https://api.yourapp.com',
  'orders',
  'insert', // filter by event type, or null for all events
  (event) => {
    orders.value = [event.data, ...orders.value];
  },
);
</script>

<template>
  <ul>
    <li v-for="order in orders" :key="order.id">{{ order.id }}</li>
  </ul>
</template>
```

### useSyncCollection (Offline-First)

```vue
<script setup lang="ts">
import { useSyncCollection } from '@zveltio/sdk-vue';

const { data: notes, loading } = useSyncCollection('notes', {
  realtimeUrl: 'https://api.yourapp.com',
});
</script>
```

---

## Local-First & Offline Sync

The `SyncManager` and `LocalStore` from `@zveltio/sdk` enable offline-first applications with IndexedDB storage and automatic background synchronization.

### LocalStore (IndexedDB)

```typescript
import { LocalStore } from '@zveltio/sdk';

const store = new LocalStore('myapp');

// Write
await store.put('posts', { id: 'local-1', title: 'Draft', _synced: false });

// Read
const post = await store.get('posts', 'local-1');
const allPosts = await store.list('posts');

// Soft delete (marks _deleted: true, queues for sync)
await store.delete('posts', 'local-1');

// Conflict resolution
const conflicts = await store.getConflicts('posts');
await store.resolveConflict('posts', 'id', 'local'); // keep local version
await store.resolveConflict('posts', 'id', 'server'); // accept server version
```

### SyncManager

```typescript
import { createZveltioClient, SyncManager } from '@zveltio/sdk';

const client = createZveltioClient({ baseUrl: 'https://api.yourapp.com' });
const sync = new SyncManager(client, { syncInterval: 30000 });

// Start — connects realtime WebSocket and begins background sync
await sync.start('https://api.yourapp.com');

// Collection proxy (reads from IndexedDB, writes queue to server)
const notes = sync.collection('notes');
const allNotes = await notes.list();
const note = await notes.get('id');
const created = await notes.create({ title: 'New note' });
await notes.update('id', { title: 'Updated' });
await notes.delete('id');

// Force immediate sync
await sync.syncNow();

// Real-time updates
notes.subscribe((records) => {
  console.log('Notes updated:', records);
});

// Stop
sync.stop();
```

### Svelte Integration

```typescript
// In a Svelte 5 component
import { useSyncCollection, useSyncStatus } from '@zveltio/sdk';

const { data, loading } = useSyncCollection(client, 'notes', {
  realtimeUrl: 'https://api.yourapp.com',
});

const { pendingOps, isSyncing, isOnline, lastSyncAt } = useSyncStatus(sync);
```

---

## Real-Time WebSocket

### Direct WebSocket client

```typescript
import { ZveltioRealtime } from '@zveltio/sdk';

const realtime = new ZveltioRealtime('https://api.yourapp.com');
realtime.connect();

// Subscribe to a collection
const unsubscribe = realtime.subscribe('orders', (event) => {
  // event: { type: 'insert' | 'update' | 'delete', data: any }
  console.log(event.type, event.data);
});

// Unsubscribe
unsubscribe();

// Auto-reconnects on disconnect — no manual handling needed
realtime.disconnect();
```

### WebSocket protocol

```json
// Subscribe
{ "type": "subscribe", "collection": "orders" }

// Unsubscribe
{ "type": "unsubscribe", "collection": "orders" }

// Ping / keepalive
{ "type": "ping" }

// Incoming events
{ "type": "insert", "collection": "orders", "data": { ... } }
{ "type": "update", "collection": "orders", "data": { ... } }
{ "type": "delete", "collection": "orders", "data": { "id": "..." } }
```

WebSocket endpoint: `ws://your-engine/api/ws`
