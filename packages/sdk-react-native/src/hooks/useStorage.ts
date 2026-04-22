import { useState, useCallback } from 'react';
import { useZveltioClient } from '../context.js';

export interface StorageFile {
  id: string;
  filename: string;
  original_name: string;
  mimetype: string;
  size: number;
  url?: string;
  created_at: string;
}

// Declare FormData as a value — present in React Native runtime
declare const FormData: { new(): {
  append(name: string, value: any, filename?: string): void;
} };

export function useStorage() {
  const client = useZveltioClient();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // React Native: accepts { uri, name, type } from image picker / file picker
  const upload = useCallback(async (
    file: { uri: string; name: string; type: string },
    folderId?: string,
  ): Promise<StorageFile | null> => {
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      // React Native fetch accepts { uri, name, type } as FormData file value
      formData.append('file', { uri: file.uri, name: file.name, type: file.type } as any, file.name);
      if (folderId) formData.append('folder_id', folderId);
      return await (client as any).upload('/api/storage/upload', formData);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      return null;
    } finally {
      setUploading(false);
    }
  }, [client]);

  const list = useCallback(
    (folderId?: string): Promise<{ files: StorageFile[] }> =>
      (client as any).get(`/api/storage${folderId ? `?folder_id=${folderId}` : ''}`),
    [client],
  );

  const remove = useCallback(
    (id: string): Promise<void> => (client as any).delete(`/api/storage/${encodeURIComponent(id)}`),
    [client],
  );

  return { upload, list, remove, uploading, error };
}
