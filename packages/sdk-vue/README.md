# @zveltio/vue

Official Vue 3 SDK for [Zveltio](https://zveltio.com) — composables for collections, real-time, auth, storage, and offline sync.

## Installation

```bash
npm install @zveltio/vue @zveltio/sdk
# or
bun add @zveltio/vue @zveltio/sdk
```

## Setup

Create a client and register the plugin:

```ts
import { createApp } from 'vue';
import { ZveltioPlugin, createZveltioClient } from '@zveltio/vue';
import App from './App.vue';

const client = createZveltioClient({ baseUrl: 'https://your-engine.example.com' });

createApp(App).use(ZveltioPlugin, { client }).mount('#app');
```

## Composables

### Data

```vue
<script setup lang="ts">
import { useRoute } from 'vue-router';
import { useCollection, useRecord } from '@zveltio/vue';

const { data, loading, error, refetch } = useCollection('products', {
  filter: { status: 'active' },
  sort: 'created_at',
  order: 'desc',
  limit: 20,
});

// Pass a getter or ref to re-fetch when the id changes; a plain string is read once.
const route = useRoute();
const { data: product } = useRecord('products', () => route.params.id as string);
</script>

<template>
  <div v-if="loading">Loading...</div>
  <p v-else-if="error">{{ error.message }}</p>
  <ProductCard v-for="p in data ?? []" :key="p.id" :product="p" />
</template>
```

### Real-time

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useRealtime } from '@zveltio/vue';

const orders = ref<any[]>([]);

useRealtime(
  'https://your-engine.example.com',
  'orders',
  'insert', // 'insert' | 'update' | 'delete', or null for every event
  (event) => orders.value.unshift(event.data),
);
</script>
```

The socket authenticates with the session cookie, so the engine must be same-site
with your app (or behind the same reverse proxy).

### Offline sync

```vue
<script setup lang="ts">
import { useSyncCollection, useSyncStatus } from '@zveltio/vue';

const { data } = useSyncCollection('products', {
  realtimeUrl: 'https://your-engine.example.com',
  syncInterval: 30_000,
});
const { status } = useSyncStatus();
</script>

<template>
  <Banner v-if="status.status === 'offline'">
    Offline — {{ status.pendingCount }} changes waiting
  </Banner>
  <div
    v-for="p in data ?? []"
    :key="p.id"
    :style="{ opacity: p._syncStatus === 'pending' ? 0.6 : 1 }"
  >
    {{ p.name }}
  </div>
</template>
```

Pass a `SyncManager` to `useSyncStatus(syncManager)` to see its pending queue;
without one it reports only the browser's online state.

### Auth

```vue
<script setup lang="ts">
import { useAuth } from '@zveltio/vue';

const { user, loading, login, logout } = useAuth();
</script>

<template>
  <div v-if="loading" />
  <button v-else-if="!user" @click="login(email, password)">Sign In</button>
  <div v-else>
    {{ user.email }}
    <button @click="logout">Sign Out</button>
  </div>
</template>
```

`session` and `signup(email, password, name)` are returned as well.

### Storage

```vue
<script setup lang="ts">
import { useStorage } from '@zveltio/vue';

const props = defineProps<{ folderId?: string }>();
const { upload, uploading, error } = useStorage();

async function handleFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) {
    const stored = await upload(file, props.folderId);
    console.log('Uploaded:', stored.url);
  }
}
</script>

<template>
  <input type="file" @change="handleFile" :disabled="uploading" />
  <p v-if="error">{{ error.message }}</p>
</template>
```

`list(folderId?)` and `remove(fileId)` are returned as well. The folder argument is a
folder **id**; omit it for the root.

## Links

- [Documentation](https://zveltio.com/docs)
- [GitHub](https://github.com/zveltio-devs/zveltio)
- [Core SDK](https://www.npmjs.com/package/@zveltio/sdk)
- [React SDK](https://www.npmjs.com/package/@zveltio/react)
