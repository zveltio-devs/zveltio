<script lang="ts">
/**
 * A `view/2` page (ADR 0042 slice 2): sets up what its views share — the
 * parameters, the pane selections, how a button runs — and draws the view.
 *
 * Every call goes to the engine as the signed-in user: the data API for
 * collections, `POST /ext/<extension>/actions/<name>` for actions. Nothing an
 * extension wrote runs here, and no URL comes from the view.
 */
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import {
  type Button,
  readActionResult,
  resolveInput,
  validateView,
  VIEW_SPEC,
  type View,
  type ViewScope,
} from '@zveltio/sdk/view';
import type { FormField } from '@zveltio/sdk/extension';
import { m } from '#lib/i18n.svelte.js';
import { api } from '#lib/api.js';
import { auth } from '#lib/auth.svelte.js';
import { toast } from '#lib/stores/toast.svelte.js';
import { createExtensionConfirm } from '#lib/utils/extension-confirm.svelte.js';
import ConfirmModal from '#lib/components/common/ConfirmModal.svelte';
import Modal from '#lib/components/common/Modal.svelte';
import SchemaForm from '#lib/components/common/SchemaForm.svelte';
import {
  actionInputFields,
  findAction,
  formPayload,
  type RunnableAction,
  runAction,
  runnableActions,
  toFormField,
  type ViewHost,
  viewHref,
} from './engine.js';
import ViewNode from './ViewNode.svelte';

interface Props {
  view: View;
  /** The extension the view belongs to; its actions run under its name. */
  ext: string;
  params?: Record<string, unknown>;
  /** The extension's pages, to find the page a `navigate` names. */
  pages?: readonly { path: string; schema?: unknown }[];
}
const { view, ext, params = {}, pages = [] }: Props = $props();

let actions = $state<RunnableAction[] | null>(null);
$effect(() => {
  runnableActions().then(
    (a) => (actions = a),
    () => (actions = null),
  );
});

const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();
let prompt = $state<{
  fields: FormField[];
  values: Record<string, unknown>;
  go: (v: Record<string, unknown>) => void;
} | null>(null);
let reveal = $state<string | null>(null);
let shown = $state<View | null>(null);

function t(s?: string): string {
  if (!s) return '';
  const fn = (m as Record<string, (() => string) | undefined>)[s];
  return typeof fn === 'function' ? fn() : s;
}

function navigate(viewId: string, p: Record<string, unknown>) {
  const href = viewHref(pages, viewId, p);
  if (href === null) return void toast.error(m['view.unknownView']({ id: viewId }));
  void goto(resolve(href.slice(1)));
}

async function run(action: string, input: Record<string, unknown>) {
  try {
    const outcome = readActionResult(await runAction(host.ext, action, input));
    host.version++;
    if (outcome.kind === 'navigate') return navigate(outcome.view, outcome.params);
    if (outcome.kind === 'reveal') return void (reveal = outcome.value);
    if (outcome.kind === 'view') {
      const checked = validateView({ ...outcome.view, spec: VIEW_SPEC });
      if (!checked.ok) return void toast.error(m['extPage.renderFailed']());
      return void (shown = outcome.view);
    }
    if (outcome.kind === 'file') {
      const { url } = await api.get<{ url: string }>(
        `/api/storage/${encodeURIComponent(outcome.file)}/signed-url`,
      );
      window.open(url, '_blank', 'noopener');
      return;
    }
    toast.success(m['common.done']());
  } catch (e) {
    toast.error((e as Error).message || m['common.failed']());
  }
}

async function press(b: Button, scope: ViewScope) {
  if ('save' in b) return;
  if ('navigate' in b) {
    const p = resolveInput(b.params, scope);
    if (!p) return void toast.error(m['view.selectFirst']());
    return navigate(b.navigate, p);
  }
  const input = resolveInput(b.input, scope);
  if (!input) return void toast.error(m['view.selectFirst']());
  const go = (asked: Record<string, unknown>) => {
    const fire = () => run(b.action, { ...input, ...asked });
    if (b.confirm)
      askConfirm(t(b.confirm), fire, {
        confirmClass: b.tone === 'danger' ? 'btn-error' : 'btn-primary',
      });
    else void fire();
  };
  if (!b.prompt?.length) return go({});
  const declared = actionInputFields(findAction(actions ?? [], host.ext, b.action)?.input);
  const fields = b.prompt.map((name) =>
    toFormField(declared.find((f) => f.name === name) ?? { name, type: 'text' }),
  );
  prompt = { fields, values: {}, go };
}

const host = $state<ViewHost>({
  ext: '',
  scope: { params: {}, selected: {}, user: undefined },
  t,
  press,
  run,
  canRun: () => true,
  version: 0,
});
$effect.pre(() => {
  host.ext = ext;
  host.scope.params = params;
  host.scope.user = auth.user?.id as string | undefined;
  // Before `GET /api/actions` answers, every button is drawn; the engine decides anyway.
  const list = actions;
  host.canRun = (a) => list === null || findAction(list, ext, a) !== undefined;
});
</script>

<ViewNode {view} {host} />

<ConfirmModal open={confirmState.open} title={confirmState.title} message={confirmState.message}
  confirmLabel={confirmState.confirmLabel} confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction} oncancel={cancelConfirm} />

{#if prompt}
  <Modal open={true} size="md" onClose={() => (prompt = null)}
    onSubmit={() => {
      const p = prompt;
      prompt = null;
      p?.go(formPayload(p.values, p.fields));
    }}>
    <SchemaForm formId={`view:${ext}:prompt`} schema={{ id: `view:${ext}:prompt`, fields: prompt.fields }} bind:values={prompt.values} />
    <div class="flex justify-end mt-4"><button type="submit" class="btn btn-primary btn-sm">{m['common.confirm']()}</button></div>
  </Modal>
{/if}

{#if reveal !== null}
  <Modal open={true} title={m['ext.reveal.title']()} size="lg" dismissible={false}>
    <p class="text-sm text-warning py-2">{m['ext.reveal.note']()}</p>
    <code class="block bg-base-200 rounded px-3 py-2 text-sm break-all select-all">{reveal}</code>
    <div class="flex justify-end mt-4"><button class="btn btn-sm" onclick={() => (reveal = null)}>{m['common.done']()}</button></div>
  </Modal>
{/if}

{#if shown}
  <Modal open={true} size="xl" onClose={() => (shown = null)}>
    <ViewNode view={shown} {host} />
  </Modal>
{/if}
