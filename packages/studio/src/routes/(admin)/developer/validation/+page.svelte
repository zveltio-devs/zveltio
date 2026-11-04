<script lang="ts">
/**
 * Validation rules — list, create, toggle, delete. The engine's
 * `/api/validation`; the page is the declarative one the retired
 * `developer/validation` extension shipped, now Studio's own.
 */
import SchemaPage from '#lib/sdui/SchemaPage.svelte';
import { schema } from './schema.js';
</script>

<div class="p-6">
  <SchemaPage {schema} />
</div>
