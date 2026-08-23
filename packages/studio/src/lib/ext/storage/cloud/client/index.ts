/**
 * storage/cloud — Client Components
 *
 * Import in your SvelteKit app:
 *   import { FileUpload } from 'zveltio-extensions/storage/cloud/client';
 *
 * Requires: storage/cloud extension active on your Zveltio instance.
 * The engine must expose POST /api/storage/presign.
 */
export { default as FileUpload } from './FileUpload.svelte';
