<script lang="ts">
 interface Props {
 value: string;
 onchange?: (font: string) => void;
 }

 let { value = 'Inter', onchange }: Props = $props();

 const fonts = [
 { name: 'Inter', category: 'Sans-serif' },
 { name: 'Roboto', category: 'Sans-serif' },
 { name: 'Poppins', category: 'Sans-serif' },
 { name: 'Open Sans', category: 'Sans-serif' },
 { name: 'Lato', category: 'Sans-serif' },
 { name: 'Montserrat', category: 'Sans-serif' },
 { name: 'Raleway', category: 'Sans-serif' },
 { name: 'Nunito', category: 'Sans-serif' },
 { name: 'Source Sans Pro', category: 'Sans-serif' },
 { name: 'Merriweather', category: 'Serif' },
 { name: 'Playfair Display', category: 'Serif' },
 { name: 'Lora', category: 'Serif' },
 { name: 'Source Code Pro', category: 'Monospace' },
 { name: 'JetBrains Mono', category: 'Monospace' },
 { name: 'Fira Code', category: 'Monospace' },
 ];

 const groupedFonts = $derived(() => {
 const groups: Record<string, typeof fonts> = {};
 for (const font of fonts) {
 if (!groups[font.category]) groups[font.category] = [];
 groups[font.category].push(font);
 }
 return groups;
 });
</script>

<div class="form-control w-full">
 <label class="label" for="font-family-select">
 <span class="label-text font-medium">Font Family</span>
 </label>

 <select id="font-family-select" class="select w-full" {value}
 onchange={(e) => onchange?.((e.target as HTMLSelectElement).value)}>
 {#each Object.entries(groupedFonts()) as [category, categoryFonts]}
 <optgroup label={category}>
 {#each categoryFonts as font}
 <option value={font.name} style="font-family: '{font.name}', sans-serif">{font.name}</option>
 {/each}
 </optgroup>
 {/each}
 </select>

 <div class="mt-4 p-4 border border-base-300 rounded-lg" style="font-family: '{value}', sans-serif">
 <p class="text-2xl font-bold mb-2">The quick brown fox</p>
 <p class="text-base mb-2">Sample text in {value} font family</p>
 <p class="text-sm opacity-70">
 ABCDEFGHIJKLMNOPQRSTUVWXYZ<br />
 abcdefghijklmnopqrstuvwxyz<br />
 0123456789
 </p>
 </div>

 <div class="label">
 <span class="label-text-alt opacity-70">Preview shows how text will look with selected font</span>
 </div>
</div>
