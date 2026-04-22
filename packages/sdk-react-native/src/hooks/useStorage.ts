import { useState, useCallback } from 'react';
import { uploadFile, listFiles, deleteFile, type StorageFile } from '@zveltio/sdk';
import { useZveltioClient } from '../context.js';

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
      // Build FormData compatible with React Native fetch
      const formData = new FormData();
      formData.append('file', { uri: file.uri, name: file.name, type: file.type } as any);
      if (folderId) formData.append('folder_id', folderId);
      return await uploadFile(client, formData);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      return null;
    } finally {
      setUploading(false);
    }
  }, [client]);

  const list = useCallback((folderId?: string) => listFiles(client, folderId), [client]);
  const remove = useCallback((id: string) => deleteFile(client, id), [client]);

  return { upload, list, remove, uploading, error };
}
