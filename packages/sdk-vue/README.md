# @zveltio/vue

Official Vue 3 SDK for [Zveltio](https://zveltio.com) — composables for collections, real-time, auth, storage, and offline sync.

## Installation

```bash
npm install @zveltio/vue @zveltio/sdk
# or
bun add @zveltio/vue @zveltio/sdk
```

## Setup

Register the plugin in your Vue app:

```ts
import { createApp } from 'vue';
import { ZveltioPlugin } from '@zveltio/vue';
import App from './App.vue';

createApp(App)
  .use(ZveltioPlugin, { url: 'https://your-engine.example.com' })
  .mount('#app');
```

## Composables

### Data

```vue
<script setup lang="ts">
import { useCollection, useRecord } from '@zveltio/vue';

const { data, loading, error, refresh } = useCollection('products', {
  filter: { status: 'active' },
  sort: '-createdAt',
  limit: 20,
});

const { data: product } = useRecord('products', 'id-123');
</script>

<template>
  <div v-if="loading">Loading...</div>
  <ProductCard v-for="p in data" :key="p.id" :product="p" />
</template>
```

### Real-time

```vue
<script setup lang="ts">
import { useRealtime } from '@zveltio/vue';

const event = useRealtime('orders');
// event.value: { action: 'create'|'update'|'delete', record: {...} } | null
</script>

<template>
  <div>Last event: {{ event?.action }}</div>
</template>
```

### Offline Sync

```vue
<script setup lang="ts">
import { useSyncCollection, useSyncStatus } from '@zveltio/vue';

const { records, pending, conflicts } = useSyncCollection('products');
const { isOnline } = useSyncStatus();
</script>

<template>
  <Banner v-if="!isOnline">Offline — syncing when reconnected</Banner>
  <div
    v-for="p in records"
    :key="p.id"
    :style="{ opacity: p._syncStatus === 'pending' ? 0.6 : 1 }"
  >
    {{ p.name }}
  </div>
</template>
```

### Auth

```vue
<script setup lang="ts">
import { useAuth } from '@zveltio/vue';

const { user, signIn, signOut, loading } = useAuth();
</script>

<template>
  <div v-if="loading" />
  <button v-else-if="!user" @click="signIn({ email, password })">Sign In</button>
  <div v-else>
    {{ user.email }}
    <button @click="signOut">Sign Out</button>
  </div>
</template>
```

### Storage

```vue
<script setup lang="ts">
import { useStorage } from '@zveltio/vue';

const { upload, uploading, progress } = useStorage();

async function handleFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) {
    const url = await upload(file);
    console.log('Uploaded:', url);
  }
}
</script>

<template>
  <input type="file" @change="handleFile" :disabled="uploading" />
  <progress v-if="uploading" :value="progress" max="100" />
</template>
```

## Links

- [Documentation](https://zveltio.com/docs)
- [GitHub](https://github.com/zveltio/zveltio)
- [Core SDK](https://www.npmjs.com/package/@zveltio/sdk)
- [React SDK](https://www.npmjs.com/package/@zveltio/react)
