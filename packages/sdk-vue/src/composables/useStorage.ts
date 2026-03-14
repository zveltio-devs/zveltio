import { ref, type Ref } from 'vue';
import { inject } from 'vue';
import { uploadFile, listFiles, removeFile, type StorageFile } from '@zveltio/sdk';
import type { ZveltioClient } from '@zveltio/sdk';
import { ZVELTIO_CLIENT_KEY } from '../plugin.js';

export function useStorage(): {
  upload: (file: File, folder?: string) => Promise<StorageFile>;
  list: (folder?: string) => Promise<StorageFile[]>;
  remove: (fileId: string) => Promise<void>;
  uploading: Ref<boolean>;
  error: Ref<Error | null>;
} {
  const client = inject<ZveltioClient>(ZVELTIO_CLIENT_KEY);
  if (!client) throw new Error('useStorage must be used within ZveltioPlugin');

  const uploading = ref(false);
  const error = ref<Error | null>(null);

  const upload = async (file: File, folder?: string): Promise<StorageFile> => {
    uploading.value = true;
    error.value = null;
    try {
      return await uploadFile(client, file, folder);
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw error.value;
    } finally {
      uploading.value = false;
    }
  };

  const list = (folder?: string) => listFiles(client, folder);
  const remove = (fileId: string) => removeFile(client, fileId);

  return { upload, list, remove, uploading, error };
}
