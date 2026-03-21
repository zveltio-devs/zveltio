// Replaces global indexedDB with a synchronous in-memory implementation.
// Must be the first import in every test file that uses LocalStore.
import 'fake-indexeddb/auto';
