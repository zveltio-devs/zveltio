import { useState, useCallback } from 'react';
import { uploadFile, listFiles, removeFile, type StorageFile } from '@zveltio/sdk';
import { useZveltioClient } from '../context.js';

export function useStorage(): {
  upload: (file: File, folder?: string) => Promise<StorageFile>;
  list: (folder?: string) => Promise<StorageFile[]>;
  remove: (fileId: string) => Promise<void>;
  uploading: boolean;
  error: Error | null;
} {
  const client = useZveltioClient();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const upload = useCallback(async (file: File, folder?: string): Promise<StorageFile> => {
    setUploading(true);
    setError(null);
    try {
      return await uploadFile(client, file, folder);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      throw e;
    } finally {
      setUploading(false);
    }
  }, [client]);

  const list = useCallback((folder?: string) => listFiles(client, folder), [client]);
  const remove = useCallback((fileId: string) => removeFile(client, fileId), [client]);

  return { upload, list, remove, uploading, error };
}
