<script lang="ts">
 import { onMount } from 'svelte';
 import { Save, Plus, Trash2, Play, CheckCircle, XCircle } from '@lucide/svelte';

 const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';
 const flowId = window.location.hash.match(/\/flows\/([^/]+)\/edit/)?.[1];

 const STEP_TYPES = [
 { type: 'condition', label: 'Condition', description: 'Branch based on a value', defaultConfig: { field: '', operator: 'eq', value: '', then: null, else: null } },
 { type: 'send_email', label: 'Send Email', description: 'Send an email notification', defaultConfig: { to: '', subject: '', body: '' } },
 { type: 'webhook', label: 'HTTP Request', description: 'Call an external URL', defaultConfig: { url: '', method: 'POST', body: {} } },
 { type: 'create_record', label: 'Create Record', description: 'Insert into a collection', defaultConfig: { collection: '', data: {} } },
 { type: 'update_record', label: 'Update Record', description: 'Update a record', defaultConfig: { collection: '', id: '{{id}}', data: {} } },
 { type: 'delay', label: 'Delay', description: 'Wait before continuing', defaultConfig: { hours: 0, minutes: 0 } },
 { type: 'ai_completion', label: 'AI Completion', description: 'Run an AI prompt', defaultConfig: { prompt: '', system: '' } },
 ];

 let flow = $state<any>(null);
 let loading = $state(true);
 let saving = $state(false);
 let saved = $state(false);
 let activeStep = $state<number | null>(null);
 let showStepPicker = $state(false);
 let runs = $state<any[]>([]);

 onMount(async () => {
 if (!flowId) return;
 await Promise.all([loadFlow(), loadRuns()]);
 });

 async function loadFlow() {
 const res = await fetch(`${engineUrl}/api/flows/${flowId}`, { credentials: 'include' });
 const data = await res.json();
 flow = data.flow;
 if (typeof flow.steps === 'string') flow.steps = JSON.parse(flow.steps);
 if (typeof flow.trigger === 'string') flow.trigger = JSON.parse(flow.trigger);
 loading = false;
 }

 async function loadRuns() {
 const res = await fetch(`${engineUrl}/api/flows/${flowId}/runs`, { credentials: 'include' });
 const data = await res.json();
 runs = data.runs || [];
 }

 function addStep(stepType: any) {
 const newStep = {
 id: crypto.randomUUID(),
 type: stepType.type,
 label: stepType.label,
 config: { ...stepType.defaultConfig },
 };
 flow.steps = [...(flow.steps || []), newStep];
 activeStep = flow.steps.length - 1;
 showStepPicker = false;
 }

 function removeStep(i: number) {
 flow.steps = flow.steps.filter((_: any, idx: number) => idx !== i);
 if (activeStep === i) activeStep = null;
 else if (activeStep !== null && activeStep > i) activeStep--;
 }

 async function save() {
 saving = true;
 try {
 await fetch(`${engineUrl}/api/flows/${flowId}`, {
 method: 'PATCH',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ name: flow.name, description: flow.description, steps: flow.steps, trigger: flow.trigger }),
 });
 saved = true;
 setTimeout(() => (saved = false), 2000);
 } finally {
 saving = false;
 }
 }

 async function runFlow() {
 await save();
 await fetch(`${engineUrl}/api/flows/${flowId}/run`, { method: 'POST', credentials: 'include' });
 setTimeout(loadRuns, 500);
 }

 function configToText(config: any): string {
 return JSON.stringify(config, null, 2);
 }

 function updateConfig(i: number, text: string) {
 try {
 flow.steps[i].config = JSON.parse(text);
 } catch {}
 }

 function statusIcon(status: string) {
 return status === 'completed' ? '✓' : status === 'failed' ? '✗' : '…';
 }

 function statusClass(status: string) {
 return status === 'completed' ? 'text-success' : status === 'failed' ? 'text-error' : 'text-warning';
 }
</script>

{#if loading}
 <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
{:else if !flow}
 <p class="text-error">Flow not found</p>
{:else}
 <div class="flex h-[calc(100vh-4rem)] gap-0">
 <!-- Left: Step canvas -->
 <div class="flex-1 flex flex-col border-r border-base-300">
 <!-- Top bar -->
 <div class="border-b border-base-300 px-4 py-2 flex items-center justify-between bg-base-100">
 <div class="flex items-center gap-3">
 <a href="#/flows" class="btn btn-ghost btn-xs">← Flows</a>
 <input type="text" bind:value={flow.name} class="font-bold text-lg bg-transparent border-none outline-none" />
 </div>
 <div class="flex gap-2">
 <button class="btn btn-ghost btn-sm gap-1" onclick={runFlow}>
 <Play size={14} />
 Run
 </button>
 <button class="btn btn-primary btn-sm gap-1" onclick={save} disabled={saving}>
 {#if saving}
 <span class="loading loading-spinner loading-xs"></span>
 {:else if saved}
 <CheckCircle size={14} />
 {:else}
 <Save size={14} />
 {/if}
 Save
 </button>
 </div>
 </div>

 <!-- Steps -->
 <div class="flex-1 overflow-y-auto p-6">
 <!-- Trigger node -->
 <div class="card bg-primary text-primary-content mb-2">
 <div class="card-body p-3">
 <div class="flex items-center gap-2">
 <div class="w-6 h-6 rounded-full bg-primary-content/20 flex items-center justify-center text-xs">T</div>
 <span class="font-medium text-sm">Trigger: {flow.trigger?.type}</span>
 {#if flow.trigger?.collection}
 <span class="text-xs opacity-70">{flow.trigger.collection} → {flow.trigger.event}</span>
 {/if}
 </div>
 </div>
 </div>

 <!-- Connector -->
 <div class="w-0.5 h-4 bg-base-300 mx-auto"></div>

 {#each flow.steps || [] as step, i}
 <!-- Step node -->
 <div
 class="card border-2 mb-0 cursor-pointer {activeStep === i ? 'border-primary bg-primary/5' : 'border-base-300 bg-base-200'}"
 onclick={() => (activeStep = i)}
 role="button"
 tabindex="0"
 >
 <div class="card-body p-3">
 <div class="flex items-center justify-between">
 <div class="flex items-center gap-2">
 <div class="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-xs font-mono">{i + 1}</div>
 <span class="font-medium text-sm">{step.label || step.type}</span>
 </div>
 <button class="btn btn-ghost btn-xs text-error" onclick={(e) => { e.stopPropagation(); removeStep(i); }}>
 <Trash2 size={12} />
 </button>
 </div>
 </div>
 </div>

 <!-- Connector -->
 <div class="w-0.5 h-4 bg-base-300 mx-auto"></div>
 {/each}

 <!-- Add step -->
 <button
 class="w-full border-2 border-dashed border-base-300 rounded-lg py-3 text-base-content/40 hover:border-primary hover:text-primary transition-colors flex items-center justify-center gap-2 text-sm"
 onclick={() => (showStepPicker = true)}
 >
 <Plus size={16} />
 Add Step
 </button>
 </div>
 </div>

 <!-- Right: Properties + runs -->
 <div class="w-80 flex flex-col bg-base-100">
 <!-- Step config -->
 <div class="flex-1 overflow-y-auto p-4 border-b border-base-300">
 {#if activeStep !== null && flow.steps?.[activeStep]}
 {@const step = flow.steps[activeStep]}
 <h3 class="font-semibold mb-3">{step.label || step.type} Config</h3>
 <div class="form-control">
 <label class="label"><span class="label-text text-xs">Label</span></label>
 <input type="text" bind:value={step.label} class="input input-sm" />
 </div>
 <div class="form-control mt-2">
 <label class="label"><span class="label-text text-xs">Config (JSON)</span></label>
 <textarea
 class="textarea textarea-sm font-mono text-xs"
 rows="8"
 value={configToText(step.config)}
 oninput={(e) => updateConfig(activeStep!, (e.target as HTMLTextAreaElement).value)}
 ></textarea>
 </div>
 {:else}
 <p class="text-sm text-base-content/40 text-center py-8">Select a step to configure it</p>
 {/if}
 </div>

 <!-- Run history -->
 <div class="p-4">
 <div class="flex items-center justify-between mb-2">
 <h3 class="font-semibold text-sm">Recent Runs</h3>
 <button class="btn btn-ghost btn-xs" onclick={loadRuns}>↻</button>
 </div>
 {#if runs.length === 0}
 <p class="text-xs text-base-content/40">No runs yet</p>
 {:else}
 <div class="space-y-1">
 {#each runs.slice(0, 8) as run}
 <div class="flex items-center gap-2 text-xs">
 <span class="{statusClass(run.status)} font-mono">{statusIcon(run.status)}</span>
 <span class="text-base-content/60 flex-1">{new Date(run.created_at).toLocaleTimeString()}</span>
 {#if run.error}
 <span class="text-error truncate max-w-32" title={run.error}>{run.error}</span>
 {/if}
 </div>
 {/each}
 </div>
 {/if}
 </div>
 </div>
 </div>

 <!-- Step picker modal -->
 {#if showStepPicker}
 <dialog class="modal modal-open">
 <div class="modal-box">
 <h3 class="font-bold text-lg mb-4">Add Step</h3>
 <div class="space-y-2">
 {#each STEP_TYPES as st}
 <button class="btn btn-outline justify-start gap-3 w-full h-auto py-3" onclick={() => addStep(st)}>
 <div class="text-left">
 <div class="font-medium">{st.label}</div>
 <div class="text-xs text-base-content/50">{st.description}</div>
 </div>
 </button>
 {/each}
 </div>
 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showStepPicker = false)}>Cancel</button>
 </div>
 </div>
 <button class="modal-backdrop" onclick={() => (showStepPicker = false)}></button>
 </dialog>
 {/if}
{/if}
