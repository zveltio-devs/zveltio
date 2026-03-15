<script lang="ts">
import { Pipette } from '@lucide/svelte';

 interface Props {
 value?: string;
 readonly?: boolean;
 showPresets?: boolean;
 }

 let { value = $bindable('#000000'), readonly = false, showPresets = true }: Props = $props();

 const presets = [
 '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00',
 '#FF00FF', '#00FFFF', '#FFA500', '#800080', '#FFC0CB', '#A52A2A',
 '#808080', '#00CED1', '#FF6347',
 ];

 async function pickFromScreen() {
 if (!('EyeDropper' in window)) {
 alert('EyeDropper API not supported in this browser');
 return;
 }
 try {
 const eyeDropper = new (window as any).EyeDropper();
 const result = await eyeDropper.open();
 value = result.sRGBHex;
 } catch {
 // cancelled
 }
 }
</script>

<div class="color-picker">
 <div class="flex gap-2 items-center">
 <input
 type="color"
 bind:value
 disabled={readonly}
 class="w-12 h-12 rounded cursor-pointer border-2 border-base-300"
 />
 <input
 type="text"
 bind:value
 disabled={readonly}
 placeholder="#000000"
 class="input input-sm flex-1 font-mono"
 maxlength="7"
 />
 {#if !readonly && 'EyeDropper' in window}
 <button type="button" class="btn btn-sm btn-ghost" onclick={pickFromScreen} title="Pick from screen">
 <Pipette size={16} />
 </button>
 {/if}
 </div>

 {#if showPresets && !readonly}
 <div class="presets mt-2 flex flex-wrap gap-1">
 {#each presets as preset}
 <button
 type="button"
 class="w-8 h-8 rounded border-2 cursor-pointer transition-transform hover:scale-110"
 class:border-primary={value === preset}
 class:border-base-300={value !== preset}
 style="background-color: {preset}"
 onclick={() => (value = preset)}
 title={preset}
 ></button>
 {/each}
 </div>
 {/if}
</div>
