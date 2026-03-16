<script lang="ts">
import { Pipette } from '@lucide/svelte';

 interface Props {
 label: string;
 value: string;
 description?: string;
 onchange?: (color: string) => void;
 }

 let { label, value = '#069494', description, onchange }: Props = $props();

 function handleChange(e: Event) {
 onchange?.((e.target as HTMLInputElement).value);
 }

 function handleTextChange(e: Event) {
 let newValue = (e.target as HTMLInputElement).value;
 if (newValue && !newValue.startsWith('#')) newValue = '#' + newValue;
 if (/^#[0-9A-Fa-f]{6}$/.test(newValue)) onchange?.(newValue);
 }

 function hexToHSL(hex: string): string {
 const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
 if (!result) return '0 0% 50%';
 const r = parseInt(result[1], 16) / 255;
 const g = parseInt(result[2], 16) / 255;
 const b = parseInt(result[3], 16) / 255;
 const max = Math.max(r, g, b), min = Math.min(r, g, b);
 let h = 0, s = 0;
 const l = (max + min) / 2;
 if (max !== min) {
 const d = max - min;
 s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
 switch (max) {
 case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
 case g: h = ((b - r) / d + 2) / 6; break;
 case b: h = ((r - g) / d + 4) / 6; break;
 }
 }
 return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
 }

 async function pickFromScreen() {
 if (!('EyeDropper' in window)) { alert('EyeDropper API not supported'); return; }
 try {
 const result = await new (window as any).EyeDropper().open();
 onchange?.(result.sRGBHex);
 } catch { /* cancelled */ }
 }

 const hslValue = $derived(hexToHSL(value));
</script>

<div class="form-control w-full">
 <label class="label" for="color-{label.replace(/\s/g, '-')}">
 <span class="label-text font-medium">{label}</span>
 </label>
 <div class="flex gap-3 items-center">
 <div class="w-16 h-16 rounded-lg border-2 border-base-300 shadow-sm cursor-pointer relative overflow-hidden" style="background-color: {value}">
 <input type="color" id="color-{label.replace(/\s/g, '-')}" class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
 {value} onchange={handleChange} aria-label="{label} color picker" />
 </div>
 <div class="flex-1">
 <div class="flex gap-2">
 <input type="text" class="input w-full font-mono" {value} onchange={handleTextChange}
 pattern="^#[0-9A-Fa-f]{6}$" placeholder="#069494" aria-label="{label} hex value" />
 {#if 'EyeDropper' in window}
 <button type="button" class="btn btn-ghost btn-square" onclick={pickFromScreen} title="Pick from screen">
 <Pipette size={18} />
 </button>
 {/if}
 </div>
 <div class="label"><span class="label-text-alt font-mono opacity-70" aria-live="polite">HSL: {hslValue}</span></div>
 </div>
 </div>
 {#if description}
 <div class="label"><span class="label-text-alt opacity-70">{description}</span></div>
 {/if}
</div>
