# TASK: Creare `packages/client` — Frontend template pentru utilizatori finali

## Context

Zveltio are două interfețe frontend:
- **Studio** (`packages/studio`) — panoul de administrare, embedded în engine, pentru admini
- **Client** (`packages/client`) — **NU EXISTĂ ÎNCĂ** — template SvelteKit pentru utilizatorii finali (angajați, parteneri, public)

Există un vechi `zveltio-client` separat care face fetch direct la API fără offline support, fără SDK, fără auth guard server-side. Acest task creează versiunea corectă în monorepo, integrată cu `@zveltio/sdk`.

**IMPORTANT:** `packages/sdk` există deja complet implementat cu:
- `ZveltioClient` — HTTP client type-safe
- `SyncManager` — offline-first cu IndexedDB, sync queue, conflict resolution
- `LocalStore` — IndexedDB wrapper cu `getPendingOps()`, `markSynced()`, `getConflicts()`, `resolveConflict()`
- `ZveltioRealtime` — WebSocket subscribe per colecție

**NU reimplementa nimic din SDK. Consumă-l via `@zveltio/sdk`.**

---

## STRUCTURA FINALĂ

```
packages/client/
├── package.json
├── svelte.config.js
├── vite.config.ts
├── tsconfig.json
├── .env.example
├── project.inlang/
│   └── settings.json
├── messages/
│   ├── en.json
│   └── ro.json
├── static/
│   └── favicon.png
└── src/
    ├── app.css
    ├── app.html
    ├── lib/
    │   ├── zveltio.ts                  ← SDK singleton
    │   ├── auth-client.ts              ← better-auth client
    │   ├── stores/
    │   │   ├── auth.svelte.ts          ← useAuth()
    │   │   ├── collection.svelte.ts    ← useCollection()
    │   │   └── realtime.svelte.ts      ← useRealtime()
    │   └── components/
    │       ├── auth/
    │       │   ├── LoginForm.svelte
    │       │   ├── SignupForm.svelte
    │       │   └── ResetPassword.svelte
    │       └── common/
    │           ├── FileUpload.svelte
    │           ├── MapPicker.svelte
    │           ├── QRDisplay.svelte
    │           └── OfflineBanner.svelte
    └── routes/
        ├── +layout.ts
        ├── +layout.svelte
        ├── +page.svelte
        ├── (public)/
        │   └── about/+page.svelte
        ├── (employee)/
        │   ├── +layout.server.ts
        │   ├── +layout.svelte
        │   └── dashboard/+page.svelte
        ├── (partner)/
        │   ├── +layout.server.ts
        │   ├── +layout.svelte
        │   └── dashboard/+page.svelte
        └── auth/
            ├── login/+page.svelte
            ├── signup/+page.svelte
            └── reset-password/+page.svelte
```

---

## FIȘIER 1: `package.json`

```json
{
  "name": "@zveltio/client",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev --port 5174",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
    "check:watch": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --watch"
  },
  "dependencies": {
    "@zveltio/sdk": "workspace:*",
    "better-auth": "^1.4.18",
    "@lucide/svelte": "^0.575.0",
    "leaflet": "^1.9.4",
    "qrcode": "^1.5.4"
  },
  "devDependencies": {
    "@sveltejs/adapter-auto": "^7.0.0",
    "@sveltejs/kit": "^2.50.2",
    "@sveltejs/vite-plugin-svelte": "^6.2.4",
    "@types/leaflet": "^1.9.21",
    "@types/qrcode": "^1.5.6",
    "daisyui": "^5.0.0",
    "svelte": "^5.49.2",
    "svelte-check": "^4.3.6",
    "tailwindcss": "^4.1.0",
    "@tailwindcss/vite": "^4.1.0",
    "typescript": "^5.9.3",
    "vite": "^7.3.1"
  }
}
```

**Note:**
- `@zveltio/sdk` via `workspace:*` — consumă SDK-ul din monorepo
- DaisyUI 5 (Tailwind 4 compatible)
- Port 5174 (Studio e pe 5173, Engine pe 3000)
- NU include `hono` — clientul nu mai are nevoie de Hono RPC, folosește SDK-ul

---

## FIȘIER 2: `svelte.config.js`

```javascript
import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: {
      '$lib': './src/lib',
      '$components': './src/lib/components',
      '$stores': './src/lib/stores',
    },
  },
};

export default config;
```

---

## FIȘIER 3: `vite.config.ts`

```typescript
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
});
```

---

## FIȘIER 4: `tsconfig.json`

```json
{
  "extends": "./.svelte-kit/tsconfig.json",
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "strict": true,
    "moduleResolution": "bundler"
  }
}
```

---

## FIȘIER 5: `.env.example`

```bash
# Zveltio Engine API URL
PUBLIC_ENGINE_URL=http://localhost:3000

# App info
PUBLIC_APP_NAME=My App
PUBLIC_APP_URL=http://localhost:5174
```

---

## FIȘIER 6: `src/app.html`

```html
<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="%sveltekit.assets%/favicon.png" />
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
```

---

## FIȘIER 7: `src/app.css`

```css
@import 'tailwindcss';
@plugin 'daisyui';
```

Notă: DaisyUI 5 + Tailwind 4 folosesc `@plugin` în loc de `plugins: []` din config.

---

## FIȘIER 8: `src/lib/zveltio.ts` — SDK Singleton

```typescript
import { ZveltioClient } from '@zveltio/sdk';
import { SyncManager } from '@zveltio/sdk';

const ENGINE_URL = import.meta.env.PUBLIC_ENGINE_URL || 'http://localhost:3000';

export const client = new ZveltioClient({ url: ENGINE_URL });

export const sync = new SyncManager(client, {
  syncInterval: 5000,
  maxRetries: 5,
  onConflict: (_local, server) => server, // Server wins by default
});

/**
 * Inițializează SDK-ul — apelat o singură dată din +layout.ts (browser-only).
 * Pornește SyncManager + WebSocket realtime.
 */
export async function initZveltio(): Promise<void> {
  await sync.start(`${ENGINE_URL}/api/ws`);
}
```

---

## FIȘIER 9: `src/lib/auth-client.ts` — Better-Auth Client

```typescript
import { createAuthClient } from 'better-auth/svelte';

const ENGINE_URL = import.meta.env.PUBLIC_ENGINE_URL || 'http://localhost:3000';

export const authClient = createAuthClient({
  baseURL: ENGINE_URL,
});

export const { signIn, signUp, signOut, useSession } = authClient;
```

---

## FIȘIER 10: `src/lib/stores/auth.svelte.ts` — useAuth()

```typescript
import { authClient, useSession } from '$lib/auth-client';
import { goto } from '$app/navigation';

/**
 * Reactive auth store cu Svelte 5 rune.
 * Folosește better-auth/svelte useSession() intern.
 */
export function useAuth() {
  const session = useSession();

  return {
    get user() { return session.data?.user ?? null; },
    get isLoggedIn() { return !!session.data?.user; },
    get isPending() { return session.isPending; },

    async signIn(email: string, password: string) {
      const result = await authClient.signIn.email({ email, password });
      if (!result.error) {
        await goto('/');
      }
      return result;
    },

    async signUp(data: { email: string; password: string; name: string }) {
      const result = await authClient.signUp.email(data);
      if (!result.error) {
        await goto('/auth/login?registered=true');
      }
      return result;
    },

    async signOut() {
      await authClient.signOut();
      await goto('/auth/login');
    },

    async resetPassword(email: string) {
      return authClient.forgetPassword({ email, redirectTo: '/auth/reset-password' });
    },
  };
}
```

---

## FIȘIER 11: `src/lib/stores/collection.svelte.ts` — useCollection()

```typescript
import { sync } from '$lib/zveltio';

/**
 * Reactive collection store — offline-first via SyncManager.
 *
 * Citirile sunt INSTANT (din IndexedDB local).
 * Scrierile se fac local + se sincronizează async cu serverul.
 *
 * Exemplu:
 * ```svelte
 * <script>
 *   import { useCollection } from '$stores/collection.svelte';
 *   const tasks = useCollection('tasks');
 * </script>
 * {#each tasks.data as task}
 *   <div>{task.title} — {task._syncStatus}</div>
 * {/each}
 * ```
 */
export function useCollection<T extends Record<string, any> = Record<string, any>>(
  collectionName: string,
) {
  let data = $state<(T & { id: string; _syncStatus?: string })[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const coll = sync.collection(collectionName);

  $effect(() => {
    let unsubscribe: (() => void) | undefined;

    // 1. Citire inițială din IndexedDB (instant)
    coll.list()
      .then((records: any[]) => {
        data = records as any;
        loading = false;
      })
      .catch((err: Error) => {
        error = err.message;
        loading = false;
      });

    // 2. Subscribe la updates (realtime + local writes)
    unsubscribe = coll.subscribe((records: any[]) => {
      data = records as any;
    });

    return () => unsubscribe?.();
  });

  return {
    get data() { return data; },
    get loading() { return loading; },
    get error() { return error; },

    async create(payload: Omit<T, 'id'>) {
      return coll.create(payload);
    },

    async update(id: string, payload: Partial<T>) {
      return coll.update(id, payload);
    },

    async remove(id: string) {
      return coll.delete(id);
    },
  };
}
```

---

## FIȘIER 12: `src/lib/stores/realtime.svelte.ts` — useRealtime()

```typescript
/**
 * SSE realtime connection pentru notificări broadcast.
 * Separat de SyncManager (care folosește WebSocket per colecție).
 * Acesta se conectează la /api/realtime (Redis Pub/Sub → SSE).
 */
export function useRealtime() {
  let isConnected = $state(false);
  const handlers = new Map<string, Set<(payload: any) => void>>();

  $effect(() => {
    if (typeof window === 'undefined') return;

    const engineUrl = import.meta.env.PUBLIC_ENGINE_URL || 'http://localhost:3000';
    const sse = new EventSource(`${engineUrl}/api/realtime`, {
      withCredentials: true,
    });

    sse.onopen = () => { isConnected = true; };
    sse.onerror = () => { isConnected = false; };

    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const channelHandlers = handlers.get(data.type) || handlers.get('*');
        channelHandlers?.forEach((h) => h(data.payload ?? data));
      } catch { /* ignore parse errors */ }
    };

    return () => sse.close();
  });

  return {
    get isConnected() { return isConnected; },

    on(channel: string, handler: (payload: any) => void): () => void {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(handler);
      return () => handlers.get(channel)?.delete(handler);
    },
  };
}
```

---

## FIȘIER 13: `src/routes/+layout.ts` — Init SDK

```typescript
import { browser } from '$app/environment';
import { initZveltio } from '$lib/zveltio';

export async function load() {
  if (browser) {
    await initZveltio();
  }
  return {};
}
```

---

## FIȘIER 14: `src/routes/+layout.svelte` — Layout global

```svelte
<script lang="ts">
  import '../app.css';
  import OfflineBanner from '$components/common/OfflineBanner.svelte';

  let { children } = $props();
</script>

<OfflineBanner />

{@render children()}
```

---

## FIȘIER 15: `src/routes/+page.svelte` — Landing page

```svelte
<script lang="ts">
  import { useAuth } from '$stores/auth.svelte';
  import { LogIn, UserPlus, LayoutDashboard } from '@lucide/svelte';

  const auth = useAuth();
</script>

<div class="hero min-h-screen bg-base-200">
  <div class="hero-content text-center">
    <div class="max-w-md">
      <h1 class="text-5xl font-bold">
        {import.meta.env.PUBLIC_APP_NAME || 'Zveltio'}
      </h1>
      <p class="py-6 text-base-content/70">
        Platformă modernă pentru gestionarea datelor, colaborare și automatizări.
      </p>

      {#if auth.isPending}
        <span class="loading loading-spinner loading-lg"></span>
      {:else if auth.isLoggedIn}
        <a href="/employee/dashboard" class="btn btn-primary gap-2">
          <LayoutDashboard size={20} />
          Go to Dashboard
        </a>
      {:else}
        <div class="flex gap-4 justify-center">
          <a href="/auth/login" class="btn btn-primary gap-2">
            <LogIn size={20} />
            Sign In
          </a>
          <a href="/auth/signup" class="btn btn-outline gap-2">
            <UserPlus size={20} />
            Create Account
          </a>
        </div>
      {/if}
    </div>
  </div>
</div>
```

---

## FIȘIER 16: `src/routes/auth/login/+page.svelte`

```svelte
<script lang="ts">
  import LoginForm from '$components/auth/LoginForm.svelte';
  import { page } from '$app/stores';
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 p-4">
  <div class="card w-full max-w-sm bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title text-2xl justify-center mb-2">Sign In</h2>

      {#if $page.url.searchParams.get('registered')}
        <div class="alert alert-success text-sm mb-2">
          Account created! Please sign in.
        </div>
      {/if}

      {#if $page.url.searchParams.get('error') === 'insufficient_role'}
        <div class="alert alert-warning text-sm mb-2">
          You don't have permission to access that page.
        </div>
      {/if}

      <LoginForm />

      <div class="divider text-sm">OR</div>
      <a href="/auth/signup" class="btn btn-ghost btn-sm">Create Account</a>
      <a href="/auth/reset-password" class="link link-primary text-sm text-center">
        Forgot password?
      </a>
    </div>
  </div>
</div>
```

---

## FIȘIER 17: `src/routes/auth/signup/+page.svelte`

```svelte
<script lang="ts">
  import SignupForm from '$components/auth/SignupForm.svelte';
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 p-4">
  <div class="card w-full max-w-sm bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title text-2xl justify-center mb-2">Create Account</h2>
      <SignupForm />
      <div class="divider text-sm">OR</div>
      <a href="/auth/login" class="btn btn-ghost btn-sm">Already have an account? Sign In</a>
    </div>
  </div>
</div>
```

---

## FIȘIER 18: `src/routes/auth/reset-password/+page.svelte`

```svelte
<script lang="ts">
  import ResetPassword from '$components/auth/ResetPassword.svelte';
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 p-4">
  <div class="card w-full max-w-sm bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title text-2xl justify-center mb-2">Reset Password</h2>
      <ResetPassword />
      <a href="/auth/login" class="link link-primary text-sm text-center mt-4">
        Back to Sign In
      </a>
    </div>
  </div>
</div>
```

---

## FIȘIER 19: `src/routes/(employee)/+layout.server.ts` — Auth Guard SSR

```typescript
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/**
 * Server-side auth guard — verifică sesiunea ÎNAINTE de a randa pagina.
 * Zero flash of unauthenticated content.
 *
 * Engine-ul gestionează sesiunile prin better-auth.
 * Cookie-ul de sesiune se trimite automat cu credentials: include.
 */
export const load: LayoutServerLoad = async ({ fetch, url }) => {
  const engineUrl = import.meta.env.PUBLIC_ENGINE_URL ?? process.env.PUBLIC_ENGINE_URL ?? 'http://localhost:3000';

  const res = await fetch(`${engineUrl}/api/auth/get-session`, {
    credentials: 'include',
  });

  if (!res.ok) {
    throw redirect(302, `/auth/login?returnTo=${encodeURIComponent(url.pathname)}`);
  }

  const session = await res.json();
  const user = session?.user;

  if (!user || !['employee', 'manager', 'admin', 'god'].includes(user.role)) {
    throw redirect(302, '/auth/login?error=insufficient_role');
  }

  return { user };
};
```

---

## FIȘIER 20: `src/routes/(employee)/+layout.svelte`

```svelte
<script lang="ts">
  import { LayoutDashboard, LogOut, User, Menu } from '@lucide/svelte';
  import { useAuth } from '$stores/auth.svelte';

  let { data, children } = $props();
  const auth = useAuth();
  let drawerOpen = $state(false);
</script>

<div class="drawer lg:drawer-open">
  <input id="sidebar" type="checkbox" class="drawer-toggle" bind:checked={drawerOpen} />

  <div class="drawer-content">
    <!-- Navbar -->
    <div class="navbar bg-base-100 shadow-sm lg:hidden">
      <label for="sidebar" class="btn btn-ghost btn-square">
        <Menu size={20} />
      </label>
      <span class="flex-1 text-lg font-semibold px-2">
        {import.meta.env.PUBLIC_APP_NAME || 'Zveltio'}
      </span>
    </div>

    <!-- Page content -->
    <main class="p-4 lg:p-8">
      {@render children()}
    </main>
  </div>

  <!-- Sidebar -->
  <div class="drawer-side z-40">
    <label for="sidebar" class="drawer-overlay"></label>
    <aside class="bg-base-200 w-64 min-h-full p-4 flex flex-col">
      <div class="text-xl font-bold mb-6 px-2">
        {import.meta.env.PUBLIC_APP_NAME || 'Zveltio'}
      </div>

      <ul class="menu flex-1">
        <li>
          <a href="/employee/dashboard" class="gap-2">
            <LayoutDashboard size={18} />
            Dashboard
          </a>
        </li>
      </ul>

      <!-- User footer -->
      <div class="border-t border-base-300 pt-4 mt-4">
        <div class="flex items-center gap-3 px-2 mb-3">
          <div class="avatar placeholder">
            <div class="bg-primary text-primary-content rounded-full w-8">
              <span class="text-xs">{data.user?.name?.[0] ?? '?'}</span>
            </div>
          </div>
          <div class="text-sm">
            <div class="font-medium">{data.user?.name}</div>
            <div class="text-base-content/50 text-xs">{data.user?.email}</div>
          </div>
        </div>
        <button onclick={() => auth.signOut()} class="btn btn-ghost btn-sm w-full justify-start gap-2">
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </aside>
  </div>
</div>
```

---

## FIȘIER 21: `src/routes/(employee)/dashboard/+page.svelte`

```svelte
<script lang="ts">
  import { useCollection } from '$stores/collection.svelte';
  import { Activity, Database, Clock } from '@lucide/svelte';

  let { data } = $props();

  // Exemplu: fetch o colecție de tasks (offline-first)
  // Developerii care folosesc template-ul înlocuiesc cu colecțiile lor
  // const tasks = useCollection('tasks');
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-3xl font-bold">Welcome, {data.user?.name}</h1>
    <p class="text-base-content/60 mt-1">Here's your dashboard overview.</p>
  </div>

  <!-- Stats -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <div class="stat bg-base-100 rounded-box shadow">
      <div class="stat-figure text-primary">
        <Database size={24} />
      </div>
      <div class="stat-title">Collections</div>
      <div class="stat-value text-primary">—</div>
      <div class="stat-desc">Connect your data</div>
    </div>

    <div class="stat bg-base-100 rounded-box shadow">
      <div class="stat-figure text-secondary">
        <Activity size={24} />
      </div>
      <div class="stat-title">Activity</div>
      <div class="stat-value text-secondary">—</div>
      <div class="stat-desc">This week</div>
    </div>

    <div class="stat bg-base-100 rounded-box shadow">
      <div class="stat-figure text-accent">
        <Clock size={24} />
      </div>
      <div class="stat-title">Last Sync</div>
      <div class="stat-value text-accent text-lg">Now</div>
      <div class="stat-desc">Offline-first enabled</div>
    </div>
  </div>

  <!-- Placeholder: developers replace this with their collections -->
  <div class="card bg-base-100 shadow">
    <div class="card-body">
      <h2 class="card-title">Getting Started</h2>
      <p class="text-base-content/60">
        This is a template dashboard. Use <code class="badge badge-ghost">useCollection('your_collection')</code>
        to connect to your Zveltio data with offline-first support.
      </p>
      <pre class="bg-base-200 p-4 rounded-lg text-sm mt-2"><code>{`<script>
  import { useCollection } from '$stores/collection.svelte';
  const products = useCollection('products');
</script>

{#each products.data as product}
  <div>{product.name} — {product._syncStatus}</div>
{/each}`}</code></pre>
    </div>
  </div>
</div>
```

---

## FIȘIER 22: `src/routes/(partner)/+layout.server.ts` — Partner Auth Guard

```typescript
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ fetch, url }) => {
  const engineUrl = import.meta.env.PUBLIC_ENGINE_URL ?? process.env.PUBLIC_ENGINE_URL ?? 'http://localhost:3000';

  const res = await fetch(`${engineUrl}/api/auth/get-session`, {
    credentials: 'include',
  });

  if (!res.ok) {
    throw redirect(302, `/auth/login?returnTo=${encodeURIComponent(url.pathname)}`);
  }

  const session = await res.json();
  const user = session?.user;

  // Partenerii + roluri superioare au acces
  if (!user || !['partner', 'manager', 'admin', 'god'].includes(user.role)) {
    throw redirect(302, '/auth/login?error=insufficient_role');
  }

  return { user };
};
```

---

## FIȘIER 23: `src/routes/(partner)/+layout.svelte`

Structură identică cu employee layout, dar cu meniu diferit. Creează un layout similar cu cel din FIȘIER 20, dar cu:
- Titlu: "Partner Portal"
- Meniu adaptat pentru parteneri (ex: Shared Documents, Orders, Messages)
- Același pattern de sidebar + drawer responsive

---

## FIȘIER 24: `src/routes/(partner)/dashboard/+page.svelte`

Structură similară cu employee dashboard dar cu conținut orientat parteneri. Placeholder cu instrucțiuni de customizare.

---

## FIȘIER 25: `src/routes/(public)/about/+page.svelte`

```svelte
<div class="max-w-2xl mx-auto py-16 px-4">
  <h1 class="text-4xl font-bold mb-4">About</h1>
  <p class="text-base-content/70 leading-relaxed">
    This application is powered by Zveltio — a modern Backend-as-a-Service platform
    with offline-first capabilities, real-time sync, and AI-powered features.
  </p>
  <a href="/" class="btn btn-ghost mt-8">← Back to Home</a>
</div>
```

---

## FIȘIER 26: `src/lib/components/auth/LoginForm.svelte`

```svelte
<script lang="ts">
  import { useAuth } from '$stores/auth.svelte';
  import { Mail, Lock, Loader2 } from '@lucide/svelte';

  const auth = useAuth();
  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function handleSubmit() {
    error = null;
    loading = true;
    try {
      const result = await auth.signIn(email, password);
      if (result.error) {
        error = result.error.message || 'Invalid credentials';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Sign in failed';
    } finally {
      loading = false;
    }
  }
</script>

<div class="space-y-4">
  {#if error}
    <div class="alert alert-error text-sm">
      <span>{error}</span>
    </div>
  {/if}

  <label class="input input-bordered flex items-center gap-2">
    <Mail size={16} class="opacity-50" />
    <input type="email" placeholder="Email" bind:value={email} class="grow" required />
  </label>

  <label class="input input-bordered flex items-center gap-2">
    <Lock size={16} class="opacity-50" />
    <input type="password" placeholder="Password" bind:value={password} class="grow" required />
  </label>

  <button
    onclick={handleSubmit}
    disabled={loading || !email || !password}
    class="btn btn-primary w-full"
  >
    {#if loading}
      <Loader2 size={18} class="animate-spin" />
    {/if}
    Sign In
  </button>
</div>
```

---

## FIȘIER 27: `src/lib/components/auth/SignupForm.svelte`

```svelte
<script lang="ts">
  import { useAuth } from '$stores/auth.svelte';
  import { Mail, Lock, User, Loader2 } from '@lucide/svelte';

  const auth = useAuth();
  let name = $state('');
  let email = $state('');
  let password = $state('');
  let confirmPassword = $state('');
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function handleSubmit() {
    error = null;

    if (password !== confirmPassword) {
      error = 'Passwords do not match';
      return;
    }

    if (password.length < 8) {
      error = 'Password must be at least 8 characters';
      return;
    }

    loading = true;
    try {
      const result = await auth.signUp({ email, password, name });
      if (result.error) {
        error = result.error.message || 'Sign up failed';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Sign up failed';
    } finally {
      loading = false;
    }
  }
</script>

<div class="space-y-4">
  {#if error}
    <div class="alert alert-error text-sm">
      <span>{error}</span>
    </div>
  {/if}

  <label class="input input-bordered flex items-center gap-2">
    <User size={16} class="opacity-50" />
    <input type="text" placeholder="Full name" bind:value={name} class="grow" required />
  </label>

  <label class="input input-bordered flex items-center gap-2">
    <Mail size={16} class="opacity-50" />
    <input type="email" placeholder="Email" bind:value={email} class="grow" required />
  </label>

  <label class="input input-bordered flex items-center gap-2">
    <Lock size={16} class="opacity-50" />
    <input type="password" placeholder="Password" bind:value={password} class="grow" required />
  </label>

  <label class="input input-bordered flex items-center gap-2">
    <Lock size={16} class="opacity-50" />
    <input type="password" placeholder="Confirm password" bind:value={confirmPassword} class="grow" required />
  </label>

  <button
    onclick={handleSubmit}
    disabled={loading || !email || !password || !name}
    class="btn btn-primary w-full"
  >
    {#if loading}
      <Loader2 size={18} class="animate-spin" />
    {/if}
    Create Account
  </button>
</div>
```

---

## FIȘIER 28: `src/lib/components/auth/ResetPassword.svelte`

```svelte
<script lang="ts">
  import { useAuth } from '$stores/auth.svelte';
  import { Mail, Loader2, CheckCircle } from '@lucide/svelte';

  const auth = useAuth();
  let email = $state('');
  let error = $state<string | null>(null);
  let sent = $state(false);
  let loading = $state(false);

  async function handleSubmit() {
    error = null;
    loading = true;
    try {
      await auth.resetPassword(email);
      sent = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to send reset email';
    } finally {
      loading = false;
    }
  }
</script>

{#if sent}
  <div class="text-center space-y-3">
    <CheckCircle size={48} class="text-success mx-auto" />
    <p>Check your email for a reset link.</p>
  </div>
{:else}
  <div class="space-y-4">
    {#if error}
      <div class="alert alert-error text-sm"><span>{error}</span></div>
    {/if}

    <label class="input input-bordered flex items-center gap-2">
      <Mail size={16} class="opacity-50" />
      <input type="email" placeholder="Email" bind:value={email} class="grow" required />
    </label>

    <button onclick={handleSubmit} disabled={loading || !email} class="btn btn-primary w-full">
      {#if loading}<Loader2 size={18} class="animate-spin" />{/if}
      Send Reset Link
    </button>
  </div>
{/if}
```

---

## FIȘIER 29: `src/lib/components/common/OfflineBanner.svelte`

```svelte
<script lang="ts">
  import { sync } from '$lib/zveltio';
  import { WifiOff, RefreshCw } from '@lucide/svelte';

  let isOnline = $state(true);
  let pendingCount = $state(0);

  $effect(() => {
    if (typeof window === 'undefined') return;

    const update = () => { isOnline = navigator.onLine; };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    isOnline = navigator.onLine;

    // Poll pending sync count via LocalStore getPendingOps()
    const interval = setInterval(async () => {
      try {
        // SyncManager expune intern store.getPendingOps()
        // Accesăm prin sync.collection('__any__') pattern sau direct
        // Pentru simplitate, verificăm dacă sync expune o metodă
        const ops = await (sync as any).store?.getPendingOps?.() ?? [];
        pendingCount = ops.length;
      } catch {
        pendingCount = 0;
      }
    }, 3000);

    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      clearInterval(interval);
    };
  });
</script>

{#if !isOnline}
  <div class="alert alert-warning shadow-lg rounded-none text-sm">
    <WifiOff size={16} />
    <span>You're offline. {pendingCount > 0 ? `${pendingCount} changes pending sync.` : 'Changes will sync when reconnected.'}</span>
  </div>
{:else if pendingCount > 0}
  <div class="alert alert-info shadow-lg rounded-none text-sm">
    <RefreshCw size={16} class="animate-spin" />
    <span>Syncing {pendingCount} pending changes...</span>
  </div>
{/if}
```

---

## FIȘIER 30: `src/lib/components/common/FileUpload.svelte`

```svelte
<script lang="ts">
  import { Upload, Loader2, CheckCircle } from '@lucide/svelte';

  interface Props {
    collection?: string;
    field?: string;
    accept?: string;
    onUploaded?: (url: string) => void;
  }

  let { collection, field, accept = '*', onUploaded }: Props = $props();

  let uploading = $state(false);
  let progress = $state(0);
  let done = $state(false);

  async function upload(file: File) {
    uploading = true;
    done = false;
    progress = 0;

    try {
      const engineUrl = import.meta.env.PUBLIC_ENGINE_URL || 'http://localhost:3000';

      // 1. Get presigned URL from Engine
      const res = await fetch(`${engineUrl}/api/storage/presign`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          collection,
          field,
        }),
      });

      if (!res.ok) throw new Error('Failed to get upload URL');
      const { uploadUrl, fileUrl } = await res.json();

      // 2. Upload directly to S3 (bypasses engine)
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) progress = Math.round((e.loaded / e.total) * 100);
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`));
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.send(file);
      });

      done = true;
      onUploaded?.(fileUrl);
    } catch (e) {
      console.error('Upload failed:', e);
    } finally {
      uploading = false;
      progress = 0;
    }
  }
</script>

<label class="flex flex-col items-center justify-center border-2 border-dashed border-base-300 rounded-xl p-6 cursor-pointer hover:border-primary transition-colors">
  <input
    type="file"
    {accept}
    onchange={(e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) upload(f);
    }}
    class="hidden"
  />

  {#if uploading}
    <Loader2 size={24} class="animate-spin text-primary mb-2" />
    <progress class="progress progress-primary w-48" value={progress} max="100"></progress>
    <span class="text-sm mt-1">{progress}%</span>
  {:else if done}
    <CheckCircle size={24} class="text-success mb-2" />
    <span class="text-sm text-success">Uploaded!</span>
  {:else}
    <Upload size={24} class="text-base-content/50 mb-2" />
    <span class="text-sm text-base-content/50">Click or drag to upload</span>
  {/if}
</label>
```

---

## FIȘIER 31: `src/lib/components/common/MapPicker.svelte`

```svelte
<script lang="ts">
  import { MapPin } from '@lucide/svelte';

  interface Props {
    lat?: number;
    lng?: number;
    zoom?: number;
    onSelect?: (lat: number, lng: number) => void;
  }

  let { lat = 44.4268, lng = 26.1025, zoom = 13, onSelect }: Props = $props();

  let mapEl: HTMLDivElement;
  let mapInstance: any = null;

  $effect(() => {
    if (typeof window === 'undefined' || !mapEl) return;

    // Dynamic import — SSR-safe
    import('leaflet').then((L) => {
      // @ts-ignore
      import('leaflet/dist/leaflet.css');

      if (mapInstance) mapInstance.remove();

      mapInstance = L.map(mapEl).setView([lat, lng], zoom);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
      }).addTo(mapInstance);

      const marker = L.marker([lat, lng], { draggable: !!onSelect }).addTo(mapInstance);

      if (onSelect) {
        marker.on('dragend', () => {
          const pos = marker.getLatLng();
          onSelect(pos.lat, pos.lng);
        });

        mapInstance.on('click', (e: any) => {
          marker.setLatLng(e.latlng);
          onSelect(e.latlng.lat, e.latlng.lng);
        });
      }
    });

    return () => {
      mapInstance?.remove();
      mapInstance = null;
    };
  });
</script>

<div bind:this={mapEl} class="w-full h-64 rounded-lg border border-base-300 z-0"></div>
```

---

## FIȘIER 32: `src/lib/components/common/QRDisplay.svelte`

```svelte
<script lang="ts">
  import QRCode from 'qrcode';

  interface Props {
    value: string;
    size?: number;
  }

  let { value, size = 200 }: Props = $props();
  let src = $state<string | null>(null);

  $effect(() => {
    QRCode.toDataURL(value, { width: size, margin: 2 }).then((url) => {
      src = url;
    });
  });
</script>

{#if src}
  <img {src} alt="QR Code" width={size} height={size} class="rounded-lg" />
{:else}
  <div class="skeleton" style:width="{size}px" style:height="{size}px"></div>
{/if}
```

---

## FIȘIER 33: `messages/en.json`

```json
{
  "app_name": "Zveltio",
  "sign_in": "Sign In",
  "sign_up": "Create Account",
  "sign_out": "Sign Out",
  "dashboard": "Dashboard",
  "welcome": "Welcome",
  "email": "Email",
  "password": "Password",
  "forgot_password": "Forgot password?",
  "offline_banner": "You're offline. Changes will sync when reconnected.",
  "syncing": "Syncing changes..."
}
```

## FIȘIER 34: `messages/ro.json`

```json
{
  "app_name": "Zveltio",
  "sign_in": "Autentificare",
  "sign_up": "Creează cont",
  "sign_out": "Deconectare",
  "dashboard": "Tablou de bord",
  "welcome": "Bun venit",
  "email": "Email",
  "password": "Parolă",
  "forgot_password": "Ai uitat parola?",
  "offline_banner": "Ești offline. Modificările se vor sincroniza la reconectare.",
  "syncing": "Se sincronizează..."
}
```

---

## REGULI IMPORTANTE

1. **NU modifica** niciun fișier din `packages/engine/`, `packages/studio/`, `packages/sdk/`, `packages/cli/`, `extensions/`.

2. **NU reimplementa** SDK-ul. Importă din `@zveltio/sdk` — clasele `ZveltioClient`, `SyncManager`, `LocalStore`, `ZveltioRealtime` există deja complet implementate.

3. **Creează** directorul `packages/client/` cu toată structura de mai sus.

4. Root `package.json` are deja `"workspaces": ["packages/*"]` — noul pachet va fi automat recunoscut.

5. Toate componentele folosesc **DaisyUI 5** class names (compatibil Tailwind 4).

6. Toate store-urile folosesc **Svelte 5 rune** (`$state`, `$effect`, `$props`), NU Svelte 4 stores.

7. Auth guards sunt **server-side** (`+layout.server.ts`), NU client-side `$effect`.

8. După creare, verifică cu `cd packages/client && bun install && bun check`.

9. Dacă `better-auth/svelte` nu expune `useSession()` compatibil cu Svelte 5, creează un wrapper manual care folosește `authClient.getSession()` cu `$state`.
