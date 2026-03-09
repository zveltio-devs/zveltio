import { ref, type Ref } from 'vue';
import type { ZveltioClient } from '@zveltio/sdk';
import { inject } from 'vue';
import { ZVELTIO_CLIENT_KEY } from '../plugin.js';

export function useStorage(): {
  upload: (file: File, folder?: string) => Promise<any>;
  list: (folder?: string) => Promise<any[]>;
  remove: (key: string) => Promise<void>;
  uploading: Ref<boolean>;
  error: Ref<Error | null>;
} {
  const client = inject<ZveltioClient>(ZVELTIO_CLIENT_KEY);
  if (!client) throw new Error('useStorage must be used within ZveltioPlugin');

  const uploading = ref(false);
  const error = ref<Error | null>(null);

  const upload = async (file: File, folder?: string) => {
    uploading.value = true;
    error.value = null;
    try {
      return await client.storage.upload(file, folder);
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw error.value;
    } finally {
      uploading.value = false;
    }
  };

  const list = async (folder?: string): Promise<any[]> => {
    const result = await client.storage.list(folder) as any;
    return result?.files ?? result ?? [];
  };

  const remove = async (key: string): Promise<void> => {
    await client.storage.delete(key);
  };

  return { upload, list, remove, uploading, error };
}
