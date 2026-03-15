<script lang="ts">
import { Check, X, Maximize2, Minimize2 } from '@lucide/svelte';

 interface Props {
 value?: string;
 readonly?: boolean;
 height?: number;
 }

 let { value = $bindable('{}'), readonly = false, height = 300 }: Props = $props();

 let valid = $state(true);
 let errorMessage = $state('');
 let fullscreen = $state(false);

 function handleInput(e: Event) {
 const content = (e.target as HTMLTextAreaElement).value;
 value = content;
 try {
 JSON.parse(content);
 valid = true;
 errorMessage = '';
 } catch (err) {
 valid = false;
 errorMessage = err instanceof Error ? err.message : 'Invalid JSON';
 }
 }

 function format() {
 try {
 const parsed = JSON.parse(value);
 value = JSON.stringify(parsed, null, 2);
 valid = true;
 errorMessage = '';
 } catch (err) {
 errorMessage = err instanceof Error ? err.message : 'Cannot format: invalid JSON';
 }
 }

 function toggleFullscreen() {
 fullscreen = !fullscreen;
 }
</script>

<div class="json-editor-wrapper" class:fullscreen>
 <div class="flex items-center justify-between p-2 bg-base-200 border-b border-base-300">
 <div class="flex items-center gap-2">
 {#if valid}
 <div class="badge badge-success badge-sm gap-1"><Check size={12} /> Valid JSON</div>
 {:else}
 <div class="badge badge-error badge-sm gap-1 max-w-xs truncate" title={errorMessage}>
 <X size={12} /> {errorMessage}
 </div>
 {/if}
 </div>
 <div class="flex gap-1">
 {#if !readonly}
 <button type="button" class="btn btn-xs btn-ghost" onclick={format}>Format</button>
 {/if}
 <button type="button" class="btn btn-xs btn-ghost" onclick={toggleFullscreen} title="Fullscreen">
 {#if fullscreen}<Minimize2 size={14} />{:else}<Maximize2 size={14} />{/if}
 </button>
 </div>
 </div>

 <textarea
 class="w-full font-mono text-sm resize-none bg-base-300 text-base-content p-3 focus:outline-none"
 style="height: {fullscreen ? 'calc(100vh - 100px)' : height + 'px'}"
 {readonly}
 bind:value
 oninput={handleInput}
 spellcheck="false"
 autocomplete="off"
 autocorrect="off"
 autocapitalize="off"
 ></textarea>
</div>

<style>
 .json-editor-wrapper {
 border: 1px solid hsl(var(--bc) / 0.2);
 border-radius: 0.5rem;
 overflow: hidden;
 }

 .json-editor-wrapper.fullscreen {
 position: fixed;
 inset: 1rem;
 z-index: 50;
 background-color: hsl(var(--b1));
 box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.25);
 }
</style>
