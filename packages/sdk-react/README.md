# @zveltio/react

Official React SDK for [Zveltio](https://zveltio.com) — hooks for collections, real-time, auth, storage, and offline sync.

## Installation

```bash
npm install @zveltio/react @zveltio/sdk
# or
bun add @zveltio/react @zveltio/sdk
```

## Setup

Wrap your app with `ZveltioProvider`:

```tsx
import { ZveltioProvider } from '@zveltio/react';

export default function App() {
  return (
    <ZveltioProvider url="https://your-engine.example.com">
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
  const { data, loading, error, refresh } = useCollection('products', {
    filter: { status: 'active' },
    sort: '-createdAt',
    limit: 20,
  });

  if (loading) return <Spinner />;
  return data.map((p) => <ProductCard key={p.id} product={p} />);
}

function ProductDetail({ id }: { id: string }) {
  const { data: product } = useRecord('products', id);
  return <div>{product?.name}</div>;
}
```

### Real-time

```tsx
import { useRealtime } from '@zveltio/react';

function LiveFeed() {
  const event = useRealtime('orders');
  // event: { action: 'create'|'update'|'delete', record: {...} } | null
  return <div>Last event: {event?.action}</div>;
}
```

### Offline Sync

```tsx
import { useSyncCollection, useSyncStatus } from '@zveltio/react';

function OfflineProducts() {
  const { records, pending, conflicts } = useSyncCollection('products');
  const { isOnline } = useSyncStatus();

  return (
    <>
      {!isOnline && <Banner>Offline — syncing when reconnected</Banner>}
      {records.map((p) => (
        <div key={p.id} style={{ opacity: p._syncStatus === 'pending' ? 0.6 : 1 }}>
          {p.name}
        </div>
      ))}
    </>
  );
}
```

### Auth

```tsx
import { useAuth } from '@zveltio/react';

function Header() {
  const { user, signIn, signOut, loading } = useAuth();

  if (loading) return null;
  if (!user) return <button onClick={() => signIn({ email, password })}>Sign In</button>;
  return (
    <div>
      {user.email} <button onClick={signOut}>Sign Out</button>
    </div>
  );
}
```

### Storage

```tsx
import { useStorage } from '@zveltio/react';

function FileUpload() {
  const { upload, uploading, progress } = useStorage();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = await upload(file);
      console.log('Uploaded:', url);
    }
  };

  return <input type="file" onChange={handleFile} disabled={uploading} />;
}
```

## Links

- [Documentation](https://zveltio.com/docs)
- [GitHub](https://github.com/zveltio/zveltio)
- [Core SDK](https://www.npmjs.com/package/@zveltio/sdk)
- [Vue SDK](https://www.npmjs.com/package/@zveltio/vue)
