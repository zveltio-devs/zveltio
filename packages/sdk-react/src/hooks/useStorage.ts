import { useState, useCallback } from 'react';
import { useZveltioClient } from '../context.js';

export interface UploadResult {
  url?: string;
  key?: string;
  [key: string]: any;
}

export function useStorage(): {
  upload: (file: File, folder?: string) => Promise<UploadResult>;
  list: (folder?: string) => Promise<any[]>;
  remove: (key: string) => Promise<void>;
  uploading: boolean;
  error: Error | null;
} {
  const client = useZveltioClient();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const upload = useCallback(async (file: File, folder?: string): Promise<UploadResult> => {
    setUploading(true);
    setError(null);
    try {
      return await client.storage.upload(file, folder) as UploadResult;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      throw e;
    } finally {
      setUploading(false);
    }
  }, [client]);

  const list = useCallback(async (folder?: string): Promise<any[]> => {
    const result = await client.storage.list(folder) as any;
    return result?.files ?? result ?? [];
  }, [client]);

  const remove = useCallback(async (key: string): Promise<void> => {
    await client.storage.delete(key);
  }, [client]);

  return { upload, list, remove, uploading, error };
}
