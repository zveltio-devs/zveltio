<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { onMount } from 'svelte';
import { page } from '$app/state';
import { goto } from '$app/navigation';
import { base } from '$app/paths';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import {
  ArrowLeft,
  Save,
  Plus,
  Trash2,
  GripVertical,
  ChevronDown,
  LoaderCircle,
  Globe,
  Mail,
  Database,
  Brain,
  Webhook,
  GitBranch,
  Play,
} from '@lucide/svelte';

const STEP_TYPES = [
  { value: 'http_request', label: m['flowEdit.typeHttp'], icon: Globe },
  { value: 'send_email', label: m['flowEdit.typeEmail'], icon: Mail },
  { value: 'create_record', label: m['flowEdit.typeCreate'], icon: Database },
  { value: 'update_record', label: m['flowEdit.typeUpdate'], icon: Database },
  { value: 'ai_decision', label: m['flowEdit.typeAi'], icon: Brain },
  { value: 'webhook', label: m['flowEdit.typeWebhook'], icon: Webhook },
  { value: 'condition', label: m['flowEdit.typeCondition'], icon: GitBranch },
] as const;

type StepType = (typeof STEP_TYPES)[number]['value'];

interface Step {
  id: string;
  name: string;
  type: StepType;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  config: Record<string, any>;
  order: number;
}

interface Flow {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  trigger_config: Record<string, any>;
  is_active: boolean;
  steps: Step[];
}

let flowId = $derived(page.params.id ?? '');
let flow = $state<Flow | null>(null);
let loading = $state(true);
let saving = $state(false);
let saveError = $state('');

let selectedStep = $state<Step | null>(null);
let showAddStep = $state(false);
let dragIdx = $state<number | null>(null);
let dragOverIdx = $state<number | null>(null);

onMount(() => loadFlow());

async function loadFlow() {
  loading = true;
  try {
    const data = await api.get<{ flow: Flow }>(`/api/flows/${flowId}`);
    flow = data.flow;
    if (flow && !flow.steps) flow.steps = [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e.message ?? m['flowEdit.loadFailed']());
  } finally {
    loading = false;
  }
}

async function saveFlow() {
  if (!flow) return;
  saving = true;
  saveError = '';
  try {
    await api.patch(`/api/flows/${flow.id}`, {
      name: flow.name,
      description: flow.description,
      steps: flow.steps,
    });
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    saveError = e.message;
  } finally {
    saving = false;
  }
}

function addStep(type: StepType) {
  if (!flow) return;
  const newStep: Step = {
    id: crypto.randomUUID(),
    name: STEP_TYPES.find((s) => s.value === type)?.label() ?? type,
    type,
    config: {},
    order: flow.steps.length,
  };
  flow.steps = [...flow.steps, newStep];
  selectedStep = newStep;
  showAddStep = false;
}

function deleteStep(id: string) {
  if (!flow) return;
  if (selectedStep?.id === id) selectedStep = null;
  flow.steps = flow.steps.filter((s) => s.id !== id).map((s, i) => ({ ...s, order: i }));
}

function selectStep(step: Step) {
  selectedStep = selectedStep?.id === step.id ? null : step;
}

function stepIcon(type: string) {
  return STEP_TYPES.find((s) => s.value === type)?.icon ?? Globe;
}

// Drag reorder helpers
function onDragStart(i: number) {
  dragIdx = i;
}
function onDragOver(i: number) {
  dragOverIdx = i;
}
function onDrop() {
  if (!flow || dragIdx === null || dragOverIdx === null || dragIdx === dragOverIdx) {
    dragIdx = null;
    dragOverIdx = null;
    return;
  }
  const steps = [...flow.steps];
  const [moved] = steps.splice(dragIdx, 1);
  steps.splice(dragOverIdx, 0, moved);
  flow.steps = steps.map((s, i) => ({ ...s, order: i }));
  if (selectedStep) {
    selectedStep = flow.steps.find((s) => s.id === selectedStep?.id) ?? null;
  }
  dragIdx = null;
  dragOverIdx = null;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
function updateStepConfig(key: string, value: any) {
  if (!selectedStep || !flow) return;
  selectedStep = { ...selectedStep, config: { ...selectedStep.config, [key]: value } };
  flow.steps = flow.steps.map((s) => (s.id === selectedStep!.id ? selectedStep! : s));
}

function updateStepName(name: string) {
  if (!selectedStep || !flow) return;
  selectedStep = { ...selectedStep, name };
  flow.steps = flow.steps.map((s) => (s.id === selectedStep!.id ? selectedStep! : s));
}
</script>

<div class="flex flex-col h-full min-h-screen">
  <!-- Toolbar -->
  <div class="flex items-center gap-3 px-4 py-3 bg-base-200 border-b border-base-300 shrink-0">
    <button class="btn btn-ghost btn-sm gap-1" onclick={() => goto(`${base}/flows`)}>
      <ArrowLeft size={16} /> {m['flowEdit.backToFlows']()}
    </button>
    <div class="divider divider-horizontal m-0 h-6"></div>
    {#if flow}
      <input
        class="input input-sm font-semibold flex-1 max-w-xs bg-transparent border-transparent hover:border-base-300 focus:border-primary"
        bind:value={flow.name}
      />
      <span class="badge badge-sm {flow.is_active ? 'badge-success' : 'badge-ghost'}">
        {flow.is_active ? m['common.col.active']() : m['flowEdit.paused']()}
      </span>
    {/if}
    <div class="flex-1"></div>
    {#if saveError}
      <span class="text-error text-xs">{saveError}</span>
    {/if}
    <button class="btn btn-primary btn-sm gap-1" onclick={saveFlow} disabled={saving || !flow}>
      {#if saving}<LoaderCircle size={15} class="animate-spin" />{:else}<Save size={15} />{/if}
      {m['common.save']()}
    </button>
  </div>

  {#if loading}
    <div class="flex justify-center items-center flex-1 py-24">
      <LoaderCircle size={36} class="animate-spin text-primary" />
    </div>
  {:else if flow}
    <div class="flex flex-1 overflow-hidden">

      <!-- Left sidebar: flow meta -->
      <aside class="w-56 shrink-0 border-r border-base-300 bg-base-100 p-4 space-y-4 overflow-y-auto">
        <div>
          <p class="text-xs font-semibold text-base-content/50 uppercase tracking-wide mb-2">{m['flowEdit.flow']()}</p>
          <div class="form-control">
            <label class="label py-0" for="sidebar-flow-name"><span class="label-text text-xs">{m['common.col.name']()}</span></label>
            <input id="sidebar-flow-name" class="input input-xs" bind:value={flow.name} />
          </div>
          <div class="form-control mt-2">
            <label class="label py-0" for="sidebar-flow-desc"><span class="label-text text-xs">{m['common.col.description']()}</span></label>
            <textarea id="sidebar-flow-desc" class="textarea textarea-xs resize-none" rows="2" bind:value={flow.description}></textarea>
          </div>
        </div>
        <div>
          <p class="text-xs font-semibold text-base-content/50 uppercase tracking-wide mb-1">{m['flowEdit.trigger']()}</p>
          <span class="badge badge-outline badge-sm">{flow.trigger_type}</span>
          {#if flow.trigger_config?.collection}
            <p class="text-xs text-base-content/50 mt-1">{flow.trigger_config.collection}</p>
          {/if}
          {#if flow.trigger_config?.expression}
            <p class="text-xs font-mono text-base-content/50 mt-1">{flow.trigger_config.expression}</p>
          {/if}
        </div>
        <div>
          <p class="text-xs font-semibold text-base-content/50 uppercase tracking-wide mb-1">{m['flowEdit.steps']()}</p>
          <p class="text-sm">{m['flowEdit.stepCount']({ count: flow.steps.length })}</p>
        </div>
      </aside>

      <!-- Center: step list canvas -->
      <main class="flex-1 overflow-y-auto p-6 bg-base-50">
        <div class="max-w-md mx-auto space-y-2">

          <!-- Trigger node -->
          <div class="card bg-primary/10 border border-primary/30">
            <div class="card-body p-3 flex-row items-center gap-3">
              <Play size={18} class="text-primary shrink-0" />
              <div class="flex-1 min-w-0">
                <p class="text-xs font-semibold text-primary uppercase tracking-wide">{m['flowEdit.trigger']()}</p>
                <p class="text-sm font-medium truncate">{flow.trigger_type}</p>
              </div>
            </div>
          </div>

          {#if flow.steps.length > 0}
            <!-- Connector -->
            <div class="flex justify-center"><div class="w-0.5 h-4 bg-base-300"></div></div>
          {/if}

          <!-- Steps -->
          {#each flow.steps as step, i}
            {@const StepIcon = stepIcon(step.type)}
            <!-- Connector between steps -->
            {#if i > 0}
              <div class="flex justify-center"><div class="w-0.5 h-3 bg-base-300"></div></div>
            {/if}

            <div
              class="card border transition-all cursor-pointer
                {selectedStep?.id === step.id ? 'border-primary bg-primary/5' : 'bg-base-200 border-base-300 hover:border-base-400'}
                {dragOverIdx === i ? 'scale-105' : ''}"
              role="button"
              tabindex="0"
              draggable="true"
              ondragstart={() => onDragStart(i)}
              ondragover={(e) => { e.preventDefault(); onDragOver(i); }}
              ondrop={onDrop}
              onclick={() => selectStep(step)}
              onkeydown={(e) => { if (e.key === 'Enter') selectStep(step); }}
            >
              <div class="card-body p-3 flex-row items-center gap-3">
                <GripVertical size={14} class="text-base-content/30 shrink-0 cursor-grab" />
                <StepIcon size={16} class="shrink-0 {selectedStep?.id === step.id ? 'text-primary' : 'text-base-content/50'}" />
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium truncate">{step.name}</p>
                  <p class="text-xs text-base-content/50">{step.type}</p>
                </div>
                <span class="text-xs text-base-content/30 shrink-0">#{i + 1}</span>
                <button
                  class="btn btn-ghost btn-xs text-error shrink-0"
                  title={m['flowEdit.deleteStep']()}
                  onclick={(e) => { e.stopPropagation(); deleteStep(step.id); }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          {/each}

          <!-- Add step -->
          <div class="flex justify-center pt-2">
            <div class="relative">
              <button class="btn btn-dashed btn-sm gap-1 border-2 border-dashed" onclick={() => (showAddStep = !showAddStep)}>
                <Plus size={14} /> {m['flowEdit.addStep']()} <ChevronDown size={12} />
              </button>
              {#if showAddStep}
                <div class="absolute top-full mt-1 left-0 z-10 bg-base-100 border border-base-300 rounded-lg shadow-lg p-1 min-w-45">
                  {#each STEP_TYPES as st}
                    {@const StIcon = st.icon}
                    <button
                      class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-base-200 rounded text-left"
                      onclick={() => addStep(st.value)}
                    >
                      <StIcon size={14} class="text-base-content/60" />
                      {st.label()}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </div>
      </main>

      <!-- Right panel: step config -->
      {#if selectedStep}
        <aside class="w-80 shrink-0 border-l border-base-300 bg-base-100 p-4 overflow-y-auto">
          <div class="flex items-center justify-between mb-4">
            <p class="font-semibold text-sm">{m['flowEdit.stepConfig']()}</p>
            <button class="btn btn-ghost btn-xs" onclick={() => (selectedStep = null)}>✕</button>
          </div>

          <div class="space-y-3">
            <div class="form-control">
              <label class="label py-0" for="step-name"><span class="label-text text-xs">{m['flowEdit.stepName']()}</span></label>
              <input
                id="step-name"
                class="input input-sm"
                value={selectedStep.name}
                oninput={(e) => updateStepName((e.target as HTMLInputElement).value)}
              />
            </div>

            <div class="form-control">
              <p class="label py-0"><span class="label-text text-xs">{m['common.col.type']()}</span></p>
              <span class="badge badge-outline">{selectedStep.type}</span>
            </div>

            <!-- Type-specific config fields -->
            {#if selectedStep.type === 'http_request'}
              <div class="form-control">
                <label class="label py-0" for="step-url"><span class="label-text text-xs">URL</span></label>
                <input
                  id="step-url"
                  class="input input-sm font-mono"
                  placeholder="https://api.example.com/endpoint"
                  value={selectedStep.config.url ?? ''}
                  oninput={(e) => updateStepConfig('url', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="form-control">
                <label class="label py-0" for="step-method"><span class="label-text text-xs">{m['flowEdit.method']()}</span></label>
                <select
                  id="step-method"
                  class="select select-sm"
                  value={selectedStep.config.method ?? 'POST'}
                  onchange={(e) => updateStepConfig('method', (e.target as HTMLSelectElement).value)}
                >
                  <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
                </select>
              </div>
              <div class="form-control">
                <label class="label py-0" for="step-body"><span class="label-text text-xs">{m['flowEdit.bodyJson']()}</span></label>
                <textarea
                  id="step-body"
                  class="textarea textarea-sm font-mono text-xs resize-none"
                  rows="4"
                  placeholder="&#123;&#125;"
                  value={selectedStep.config.body ?? ''}
                  oninput={(e) => updateStepConfig('body', (e.target as HTMLTextAreaElement).value)}
                ></textarea>
              </div>

            {:else if selectedStep.type === 'send_email'}
              <div class="form-control">
                <label class="label py-0" for="step-to"><span class="label-text text-xs">{m['common.col.to']()}</span></label>
                <input
                  id="step-to"
                  class="input input-sm"
                  placeholder="&#123;&#123;record.email&#125;&#125;"
                  value={selectedStep.config.to ?? ''}
                  oninput={(e) => updateStepConfig('to', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="form-control">
                <label class="label py-0" for="step-subject"><span class="label-text text-xs">{m['common.col.subject']()}</span></label>
                <input
                  id="step-subject"
                  class="input input-sm"
                  placeholder={m['flowEdit.welcomePh']()}
                  value={selectedStep.config.subject ?? ''}
                  oninput={(e) => updateStepConfig('subject', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="form-control">
                <label class="label py-0" for="step-email-body"><span class="label-text text-xs">{m['flowEdit.body']()}</span></label>
                <textarea
                  id="step-email-body"
                  class="textarea textarea-sm resize-none"
                  rows="4"
                  placeholder={m['flowEdit.emailBodyPh']({ token: '{{record.name}}' })}
                  value={selectedStep.config.body ?? ''}
                  oninput={(e) => updateStepConfig('body', (e.target as HTMLTextAreaElement).value)}
                ></textarea>
              </div>

            {:else if selectedStep.type === 'create_record' || selectedStep.type === 'update_record'}
              <div class="form-control">
                <label class="label py-0" for="step-collection"><span class="label-text text-xs">{m['common.col.collection']()}</span></label>
                <input
                  id="step-collection"
                  class="input input-sm"
                  placeholder="collection_name"
                  value={selectedStep.config.collection ?? ''}
                  oninput={(e) => updateStepConfig('collection', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="form-control">
                <label class="label py-0" for="step-data"><span class="label-text text-xs">{m['flowEdit.dataJson']()}</span></label>
                <textarea
                  id="step-data"
                  class="textarea textarea-sm font-mono text-xs resize-none"
                  rows="4"
                  placeholder="&#123;&quot;field&quot;: &quot;&#123;&#123;record.value&#125;&#125;&quot;&#125;"
                  value={selectedStep.config.data ?? ''}
                  oninput={(e) => updateStepConfig('data', (e.target as HTMLTextAreaElement).value)}
                ></textarea>
              </div>

            {:else if selectedStep.type === 'ai_decision'}
              <div class="form-control">
                <label class="label py-0" for="step-prompt"><span class="label-text text-xs">{m['flowEdit.prompt']()}</span></label>
                <textarea
                  id="step-prompt"
                  class="textarea textarea-sm resize-none"
                  rows="4"
                  placeholder={m['flowEdit.promptPh']({ token: '{{record.text}}' })}
                  value={selectedStep.config.prompt ?? ''}
                  oninput={(e) => updateStepConfig('prompt', (e.target as HTMLTextAreaElement).value)}
                ></textarea>
              </div>
              <div class="form-control">
                <label class="label py-0" for="step-model"><span class="label-text text-xs">{m['flowEdit.modelOptional']()}</span></label>
                <input
                  id="step-model"
                  class="input input-sm"
                  placeholder="gpt-4o"
                  value={selectedStep.config.model ?? ''}
                  oninput={(e) => updateStepConfig('model', (e.target as HTMLInputElement).value)}
                />
              </div>

            {:else if selectedStep.type === 'condition'}
              <div class="form-control">
                <label class="label py-0" for="step-expression"><span class="label-text text-xs">{m['flowEdit.conditionExpr']()}</span></label>
                <input
                  id="step-expression"
                  class="input input-sm font-mono"
                  placeholder="&#123;&#123;record.status&#125;&#125; === 'active'"
                  value={selectedStep.config.expression ?? ''}
                  oninput={(e) => updateStepConfig('expression', (e.target as HTMLInputElement).value)}
                />
              </div>

            {:else if selectedStep.type === 'webhook'}
              <div class="form-control">
                <label class="label py-0" for="step-webhook-url"><span class="label-text text-xs">{m['flowEdit.webhookUrl']()}</span></label>
                <input
                  id="step-webhook-url"
                  class="input input-sm font-mono"
                  placeholder="https://hooks.example.com/..."
                  value={selectedStep.config.url ?? ''}
                  oninput={(e) => updateStepConfig('url', (e.target as HTMLInputElement).value)}
                />
              </div>
            {/if}

            <!-- Raw config JSON (advanced) -->
            <details class="mt-2">
              <summary class="text-xs text-base-content/40 cursor-pointer">{m['flowEdit.advancedRaw']()}</summary>
              <pre class="mt-2 text-xs bg-base-300 p-2 rounded overflow-auto max-h-40">{JSON.stringify(selectedStep.config, null, 2)}</pre>
            </details>
          </div>
        </aside>
      {/if}
    </div>
  {/if}
</div>
