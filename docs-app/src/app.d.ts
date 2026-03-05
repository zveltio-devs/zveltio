/// <reference types="@sveltejs/kit" />

declare module '*.md' {
  import type { ComponentType } from 'svelte';
  const component: ComponentType;
  export default component;
}

declare module '$lib/content/*.md' {
  import type { ComponentType } from 'svelte';
  const component: ComponentType;
  export default component;
}
