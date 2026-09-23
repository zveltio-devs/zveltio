# @zveltio/react

Official React SDK for [Zveltio](https://zveltio.com) — hooks for collections, real-time, auth, storage, and offline sync.

## Installation

```bash
npm install @zveltio/react @zveltio/sdk
# or
bun add @zveltio/react @zveltio/sdk
```

## Setup

Create a client and wrap your app with `ZveltioProvider`:

```tsx
import { ZveltioProvider, createZveltioClient } from '@zveltio/react';

const client = createZveltioClient({ baseUrl: 'https://your-engine.example.com' });

export default function App() {
  return (
    <ZveltioProvider client={client}>
      <YourApp />
    </ZveltioProvider>
  );
}
```

## Hooks

### Data

```tsx
import { useCollection, useRecord } from '@zveltio/react';

function ProductList() {
  const { data, loading, error, refetch } = useCollection('products', {
    filter: { status: 'active' },
    sort: 'created_at',
    order: 'desc',
    limit: 20,
  });

  if (loading) return <Spinner />;
  if (error) return <p>{error.message}</p>;
  return (data ?? []).map((p) => <ProductCard key={p.id} product={p} />);
}

function ProductDetail({ id }: { id: string }) {
  // Re-fetches when `id` changes.
  const { data: product } = useRecord('products', id);
  return <div>{product?.name}</div>;
}
```

### Real-time

```tsx
import { useRealtime } from '@zveltio/react';

function LiveOrders() {
  const [orders, setOrders] = useState([]);

  useRealtime(
    'https://your-engine.example.com',
    'orders',
    'insert', // 'insert' | 'update' | 'delete', or null for every event
    (event) => setOrders((prev) => [event.data, ...prev]),
  );

  return <OrderList orders={orders} />;
}
```

The socket authenticates with the session cookie, so the engine must be same-site
with your app (or behind the same reverse proxy).

### Offline sync

```tsx
import { useSyncCollection, useSyncStatus } from '@zveltio/react';

function OfflineProducts() {
  const { data } = useSyncCollection('products', {
    realtimeUrl: 'https://your-engine.example.com',
    syncInterval: 30_000,
  });
  const { status, pendingCount } = useSyncStatus();

  return (
    <>
      {status === 'offline' && <Banner>Offline — {pendingCount} changes waiting</Banner>}
      {(data ?? []).map((p) => (
        <div key={p.id} style={{ opacity: p._syncStatus === 'pending' ? 0.6 : 1 }}>
          {p.name}
        </div>
      ))}
    </>
  );
}
```

Pass a `SyncManager` to `useSyncStatus(syncManager)` to see its pending queue;
without one it reports only the browser's online state.

### Auth

```tsx
import { useAuth } from '@zveltio/react';

function Header() {
  const { data, loading, login, logout } = useAuth();

  if (loading) return null;
  if (!data?.user) return <button onClick={() => login(email, password)}>Sign In</button>;
  return (
    <div>
      {data.user.email} <button onClick={logout}>Sign Out</button>
    </div>
  );
}
```

`signup(email, password, name)` is returned alongside `login` and `logout`.

### Storage

```tsx
import { useStorage } from '@zveltio/react';

function FileUpload({ folderId }: { folderId?: string }) {
  const { upload, uploading, error } = useStorage();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const stored = await upload(file, folderId);
      console.log('Uploaded:', stored.url);
    }
  };

  return <input type="file" onChange={handleFile} disabled={uploading} />;
}
```

`list(folderId?)` and `remove(fileId)` are returned as well. The folder argument is a
folder **id**; omit it for the root.

## Links

- [Documentation](https://zveltio.com/docs)
- [GitHub](https://github.com/zveltio-devs/zveltio)
- [Core SDK](https://www.npmjs.com/package/@zveltio/sdk)
- [Vue SDK](https://www.npmjs.com/package/@zveltio/vue)
