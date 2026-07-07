/**
 * Framework-agnostic core logic shared by sdk-react and sdk-vue.
 *
 * Each function returns a plain Promise. Framework wrappers (React hooks /
 * Vue composables) are responsible only for binding these to their reactive
 * state primitives (useState/ref) and lifecycle hooks (useEffect/onMounted).
 */

import type { ZveltioClient } from './client.js';
import type { ZveltioRealtime } from './realtime.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CollectionOptions {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  filter?: Record<string, any>;
  search?: string;
}

export interface CollectionResult<T> {
  records: T[];
  pagination: { total: number; page: number; limit: number; pages: number };
}

export interface AuthState {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  user: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  session: any | null;
}

export interface StorageFile {
  id: string;
  filename: string;
  url: string;
  size: number;
  mime_type: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  [key: string]: any;
}

export interface SyncStatus {
  pendingOps: number;
  isSyncing: boolean;
  lastSyncAt: Date | null;
  isOnline: boolean;
}

// ── Collection ────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export async function fetchCollection<T = any>(
  client: ZveltioClient,
  collectionName: string,
  options?: CollectionOptions,
): Promise<T[]> {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const result = await client.collection(collectionName).list(options as any);
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  return (result as any)?.data ?? (result as any)?.records ?? result ?? [];
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export async function fetchRecord<T = any>(
  client: ZveltioClient,
  collectionName: string,
  id: string,
): Promise<T | null> {
  const result = await client.collection(collectionName).get(id);
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  return (result as any)?.data ?? (result as any)?.record ?? result ?? null;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export async function createRecord<T = any>(
  client: ZveltioClient,
  collectionName: string,
  data: Partial<T>,
): Promise<T> {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const result = await client.collection(collectionName).create(data as any);
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  return (result as any)?.data ?? (result as any)?.record ?? result;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export async function updateRecord<T = any>(
  client: ZveltioClient,
  collectionName: string,
  id: string,
  data: Partial<T>,
): Promise<T> {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const result = await client.collection(collectionName).update(id, data as any);
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  return (result as any)?.data ?? (result as any)?.record ?? result;
}

export async function deleteRecord(
  client: ZveltioClient,
  collectionName: string,
  id: string,
): Promise<void> {
  await client.collection(collectionName).delete(id);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function fetchSession(client: ZveltioClient): Promise<AuthState> {
  try {
    const session = await client.auth.session();
    return { user: session?.user ?? null, session };
  } catch {
    return { user: null, session: null };
  }
}

export async function loginUser(
  client: ZveltioClient,
  email: string,
  password: string,
): Promise<AuthState> {
  await client.auth.login(email, password);
  return fetchSession(client);
}

export async function logoutUser(client: ZveltioClient): Promise<AuthState> {
  await client.auth.logout();
  return { user: null, session: null };
}

export async function signupUser(
  client: ZveltioClient,
  email: string,
  password: string,
  name: string,
): Promise<AuthState> {
  await client.auth.signup(email, password, name);
  return fetchSession(client);
}

// ── Storage ───────────────────────────────────────────────────────────────────

export async function uploadFile(
  client: ZveltioClient,
  file: File,
  folder?: string,
): Promise<StorageFile> {
  const result = await client.storage.upload(file, folder);
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  return (result as any)?.data ?? (result as any)?.file ?? result;
}

export async function listFiles(client: ZveltioClient, folder?: string): Promise<StorageFile[]> {
  const result = await client.storage.list(folder);
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  return (result as any)?.data ?? (result as any)?.files ?? result ?? [];
}

export async function removeFile(client: ZveltioClient, fileId: string): Promise<void> {
  await client.storage.delete(fileId);
}

// ── Realtime ──────────────────────────────────────────────────────────────────

export function subscribeToCollection(
  realtime: ZveltioRealtime,
  collection: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  callback: (event: { type: string; data: any }) => void,
): () => void {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  return realtime.subscribe(collection, callback as any);
}
