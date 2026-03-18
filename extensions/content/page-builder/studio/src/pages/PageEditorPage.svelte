<script lang="ts">
 import { onMount } from 'svelte';
 import { Save, Plus, Eye, Trash2, ChevronUp, ChevronDown } from '@lucide/svelte';

 const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

 // Extract page ID from route hash: #/pages/:id/edit
 const pageId = window.location.hash.match(/\/pages\/([^/]+)\/edit/)?.[1];

 let page = $state<any>(null);
 let blockTypes = $state<any[]>([]);
 let loading = $state(true);
 let saving = $state(false);
 let saved = $state(false);
 let activeBlock = $state<number | null>(null);
 let showBlockPicker = $state(false);

 onMount(async () => {
 await Promise.all([loadPage(), loadBlockTypes()]);
 });

 async function loadPage() {
 if (!pageId) return;
 const res = await fetch(`${engineUrl}/api/pages/${pageId}`, { credentials: 'include' });
 const data = await res.json();
 page = data.page;
 loading = false;
 }

 async function loadBlockTypes() {
 const res = await fetch(`${engineUrl}/api/pages/block-types`, { credentials: 'include' });
 const data = await res.json();
 blockTypes = data.block_types || [];
 }

 function addBlock(type: any) {
 const newBlock = {
 id: crypto.randomUUID(),
 type: type.name,
 props: { ...type.default_props },
 };
 page.blocks = [...(page.blocks || []), newBlock];
 activeBlock = page.blocks.length - 1;
 showBlockPicker = false;
 }

 function removeBlock(i: number) {
 page.blocks = page.blocks.filter((_: any, idx: number) => idx !== i);
 if (activeBlock === i) activeBlock = null;
 else if (activeBlock !== null && activeBlock > i) activeBlock--;
 }

 function moveBlock(i: number, dir: -1 | 1) {
 const j = i + dir;
 if (j < 0 || j >= page.blocks.length) return;
 const b = [...page.blocks];
 [b[i], b[j]] = [b[j], b[i]];
 page.blocks = b;
 activeBlock = j;
 }

 async function save(status?: string) {
 if (!page) return;
 saving = true;
 try {
 await fetch(`${engineUrl}/api/pages/${pageId}`, {
 method: 'PATCH',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 title: page.title,
 slug: page.slug,
 description: page.description,
 blocks: page.blocks,
 meta: page.meta,
 ...(status ? { status } : {}),
 }),
 });
 saved = true;
 setTimeout(() => (saved = false), 2000);
 } finally {
 saving = false;
 }
 }

 function getBlockType(typeName: string) {
 return blockTypes.find((bt) => bt.name === typeName);
 }
</script>

{#if loading}
 <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
{:else if !page}
 <div class="text-center py-12"><p class="text-error">Page not found</p></div>
{:else}
 <div class="flex h-[calc(100vh-4rem)] gap-0">
 <!-- Left: Block canvas -->
 <div class="flex-1 overflow-y-auto border-r border-base-300">
 <!-- Top bar -->
 <div class="sticky top-0 bg-base-100 border-b border-base-300 px-4 py-2 flex items-center justify-between z-10">
 <div class="flex items-center gap-3">
 <a href="#/pages" class="btn btn-ghost btn-xs">← Pages</a>
 <div>
 <input
 type="text"
 bind:value={page.title}
 class="font-bold text-lg bg-transparent border-none outline-none"
 />
 <p class="text-xs text-base-content/40 font-mono">/{page.slug}</p>
 </div>
 </div>
 <div class="flex gap-2">
 <span class="badge {page.status === 'published' ? 'badge-success' : 'badge-warning'} badge-sm">{page.status}</span>
 {#if page.status !== 'published'}
 <button class="btn btn-ghost btn-sm" onclick={() => save('published')}>Publish</button>
 {/if}
 <button class="btn btn-primary btn-sm gap-1" onclick={() => save()} disabled={saving}>
 {#if saving}
 <span class="loading loading-spinner loading-xs"></span>
 {:else if saved}
 ✓
 {:else}
 <Save size={14} />
 {/if}
 Save
 </button>
 </div>
 </div>

 <!-- Blocks -->
 <div class="p-6 space-y-2">
 {#each page.blocks as block, i}
 <div
 class="relative border-2 rounded-lg transition-colors cursor-pointer {activeBlock === i ? 'border-primary' : 'border-transparent hover:border-base-300'}"
 onclick={() => (activeBlock = i)}
 role="button"
 tabindex="0"
 >
 <!-- Block header -->
 <div class="absolute -top-3 left-2 flex items-center gap-1 bg-base-100 px-2 text-xs text-base-content/40">
 {getBlockType(block.type)?.display_name || block.type}
 </div>

 <!-- Block controls -->
 {#if activeBlock === i}
 <div class="absolute -top-3 right-2 flex gap-1 bg-base-100">
 <button class="btn btn-ghost btn-xs" onclick={(e) => { e.stopPropagation(); moveBlock(i, -1); }} disabled={i === 0}>
 <ChevronUp size={12} />
 </button>
 <button class="btn btn-ghost btn-xs" onclick={(e) => { e.stopPropagation(); moveBlock(i, 1); }} disabled={i === page.blocks.length - 1}>
 <ChevronDown size={12} />
 </button>
 <button class="btn btn-ghost btn-xs text-error" onclick={(e) => { e.stopPropagation(); removeBlock(i); }}>
 <Trash2 size={12} />
 </button>
 </div>
 {/if}

 <!-- Block preview -->
 <div class="p-4">
 {#if block.type === 'hero'}
 <div class="text-center py-6 bg-base-200 rounded">
 <h2 class="text-2xl font-bold">{block.props.title || 'Hero Title'}</h2>
 {#if block.props.subtitle}<p class="text-base-content/60">{block.props.subtitle}</p>{/if}
 {#if block.props.cta_text}<button class="btn btn-primary btn-sm mt-2">{block.props.cta_text}</button>{/if}
 </div>
 {:else if block.type === 'richtext'}
 <div class="prose prose-sm max-w-none">{@html block.props.content || '<p>Empty text block</p>'}</div>
 {:else if block.type === 'image'}
 {#if block.props.url}
 <img src={block.props.url} alt={block.props.alt} class="max-w-full rounded" />
 {:else}
 <div class="bg-base-200 h-32 rounded flex items-center justify-center text-base-content/40">Image placeholder</div>
 {/if}
 {:else if block.type === 'spacer'}
 <div style="height: {block.props.height}px" class="bg-base-200 rounded flex items-center justify-center text-xs text-base-content/30">
 Spacer ({block.props.height}px)
 </div>
 {:else}
 <div class="bg-base-200 rounded p-3 text-sm text-base-content/60 font-mono">
 {block.type} block
 </div>
 {/if}
 </div>
 </div>
 {/each}

 <!-- Add block button -->
 <button
 class="w-full border-2 border-dashed border-base-300 rounded-lg py-4 text-base-content/40 hover:border-primary hover:text-primary transition-colors flex items-center justify-center gap-2"
 onclick={() => (showBlockPicker = true)}
 >
 <Plus size={18} />
 Add Block
 </button>
 </div>
 </div>

 <!-- Right: Properties panel -->
 <div class="w-72 overflow-y-auto bg-base-100 p-4">
 {#if activeBlock !== null && page.blocks[activeBlock]}
 {@const block = page.blocks[activeBlock]}
 {@const btype = getBlockType(block.type)}
 <h3 class="font-semibold mb-3">{btype?.display_name || block.type} Properties</h3>

 {#if btype?.schema}
 <div class="space-y-3">
 {#each Object.entries(btype.schema) as [key, type]}
 <div class="form-control">
 <label class="label" for="block-prop-{key}"><span class="label-text text-sm capitalize">{key.replace(/_/g, ' ')}</span></label>
 {#if type === 'string'}
 {#if key === 'content'}
 <textarea id="block-prop-{key}" bind:value={block.props[key]} class="textarea textarea-sm" rows="4"></textarea>
 {:else}
 <input id="block-prop-{key}" type="text" bind:value={block.props[key]} class="input input-sm" />
 {/if}
 {:else if type === 'number'}
 <input id="block-prop-{key}" type="number" bind:value={block.props[key]} class="input input-sm" />
 {/if}
 </div>
 {/each}
 </div>
 {/if}
 {:else}
 <div class="text-center py-8 text-base-content/40 text-sm">
 Select a block to edit its properties
 </div>
 {/if}
 </div>
 </div>

 <!-- Block picker modal -->
 {#if showBlockPicker}
 <dialog class="modal modal-open">
 <div class="modal-box">
 <h3 class="font-bold text-lg mb-4">Add Block</h3>
 <div class="grid grid-cols-2 gap-2">
 {#each blockTypes as bt}
 <button
 class="btn btn-outline justify-start gap-2 h-auto py-3"
 onclick={() => addBlock(bt)}
 >
 <div class="text-left">
 <div class="font-medium text-sm">{bt.display_name}</div>
 {#if bt.description}
 <div class="text-xs text-base-content/50">{bt.description}</div>
 {/if}
 </div>
 </button>
 {/each}
 </div>
 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showBlockPicker = false)}>Cancel</button>
 </div>
 </div>
 <button class="modal-backdrop" onclick={() => (showBlockPicker = false)}></button>
 </dialog>
 {/if}
{/if}
