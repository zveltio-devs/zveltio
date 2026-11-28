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
  type Change,
  fileIds,
  readActionResult,
  resolveFiles,
  resolveInput,
  type View,
  type ViewScope,
} from '@zveltio/sdk/view';
import type { FormField } from '@zveltio/sdk/extension';
import { m } from '#lib/i18n.svelte.js';
import { dataApi } from '#lib/api.js';
import { auth } from '#lib/auth.svelte.js';
import { toast } from '#lib/stores/toast.svelte.js';
import { createExtensionConfirm } from '#lib/utils/extension-confirm.svelte.js';
import ConfirmModal from '#lib/components/common/ConfirmModal.svelte';
import Modal from '#lib/components/common/Modal.svelte';
import SchemaForm from '#lib/components/common/SchemaForm.svelte';
import {
  actionInputFields,
  type FileHandoff,
  type FileValue,
  findAction,
  formPayload,
  openFile,
  type RunnableAction,
  runAction,
  runnableActions,
  toFormField,
  type ViewHost,
  viewHref,
  WHOLE,
} from './engine.js';
import ViewFiles from './ViewFiles.svelte';
import ViewNode from './ViewNode.svelte';
import ViewPicker from './ViewPicker.svelte';

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
  /** A button's `files.prompt`: the one file the caller picks, uploaded on pick. */
  file: { input: string; label: string; value: FileValue | null } | null;
  go: (v: Record<string, unknown>, picked?: string) => Promise<void>;
  /** Settles the `press` that opened it: after the action, or on close. */
  done: () => void;
} | null>(null);
/** Settles the `press` waiting on the confirm dialog, on confirm or cancel. */
let confirmDone: (() => void) | null = null;
function settleConfirm() {
  const d = confirmDone;
  confirmDone = null;
  d?.();
}
let reveal = $state<string | null>(null);
let shown = $state<View | null>(null);

function t(s?: string): string {
  if (!s) return '';
  // Own keys only: `toString` or `constructor` is literal text, not the bundle's.
  const fn = Object.hasOwn(m, s) ? (m as Record<string, unknown>)[s] : undefined;
  return typeof fn === 'function' ? (fn as () => string)() : s;
}

function navigate(viewId: string, p: Record<string, unknown>) {
  const href = viewHref(pages, viewId, p);
  if (href === null) return void toast.error(m['view.unknownView']({ id: viewId }));
  void goto(resolve(href.slice(1)));
}

/** Runs an action and acts on its result; `true` once the engine ran it. */
async function run(
  action: string,
  input: Record<string, unknown>,
  opts: { files?: FileHandoff; quiet?: boolean } = {},
): Promise<boolean> {
  let result: unknown;
  try {
    result = await runAction(host.ext, action, input, opts.files);
  } catch (e) {
    toast.error((e as Error).message || m['common.failed']());
    return false;
  }
  host.version++;
  if (!opts.quiet) await settle(result);
  return true;
}

/** While a button is busy the page reads its records again; one timer for all of them. */
const POLL_MS = 3000;
// ponytail: polling stops after 10 minutes on the page's busy spell (a job that
// never settles); a reload or a new busy spell starts it again. Realtime record
// events (ADR 0036) would replace the timer.
const POLL_CEILING_MS = 10 * 60_000;
let holds = 0;
let poll: ReturnType<typeof setInterval> | undefined;
function hold(): () => void {
  if (holds++ === 0) {
    const since = Date.now();
    poll = setInterval(() => {
      if (Date.now() - since > POLL_CEILING_MS) return clearInterval(poll);
      host.version++;
    }, POLL_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds === 0) clearInterval(poll);
  };
}
$effect(() => () => clearInterval(poll));

async function settle(result: unknown) {
  try {
    const outcome = readActionResult(result);
    // Not an `ActionResult`: the action ran, its result cannot be read.
    if (outcome.kind === 'invalid') {
      toast.error(m['extPage.renderFailed']());
      return;
    }
    if (outcome.kind === 'navigate') return navigate(outcome.view, outcome.params);
    if (outcome.kind === 'reveal') {
      reveal = outcome.value;
      return;
    }
    if (outcome.kind === 'view') {
      // Already checked against the vocabulary as part of `ActionResult`.
      shown = outcome.view;
      return;
    }
    if (outcome.kind === 'file') return await openFile(outcome.file);
    // This window, never an iframe: the engine admitted only https on a host the operator named (ADR 0061).
    if (outcome.kind === 'redirect') return void window.location.assign(outcome.url);
    toast.success(m['common.done']());
  } catch (e) {
    toast.error((e as Error).message || m['common.failed']());
  }
}

async function press(
  b: Button,
  scope: ViewScope,
  before?: (s: ViewScope) => Promise<ViewScope | null>,
) {
  if ('save' in b) return;
  if ('navigate' in b) {
    const p = resolveInput(b.params, scope);
    if (!p) return void toast.error(m['view.selectFirst']());
    return navigate(b.navigate, p);
  }
  // Without `before` the input is known now; with it (a form saving first),
  // only once the prompt and the confirm went through and the save did.
  const bound = (s: ViewScope) => {
    const input = resolveInput(b.input, s);
    const files = resolveFiles(b.files, s);
    return input && files !== null ? { input, files } : null;
  };
  if (!before && !bound(scope)) return void toast.error(m['view.selectFirst']());
  // The view's bound input wins: a prompt never overrides what the view fixed.
  const go = (asked: Record<string, unknown>, picked?: string): Promise<void> => {
    const fire = async () => {
      const s = before ? await before(scope) : scope;
      if (!s) return;
      const call = bound(s);
      if (!call) return void toast.error(m['view.selectFirst']());
      // The picked file goes with the ids the view hands (ADR 0052).
      const files = picked
        ? { ...call.files, read: [...new Set([...(call.files?.read ?? []), picked])] }
        : call.files;
      await run(b.action, { ...asked, ...call.input }, { files });
    };
    if (!b.confirm) return fire();
    settleConfirm();
    return new Promise<void>((resolve) => {
      confirmDone = resolve;
      askConfirm(
        t(b.confirm),
        async () => {
          try {
            await fire();
          } finally {
            settleConfirm();
          }
        },
        { confirmClass: b.tone === 'danger' ? 'btn-error' : 'btn-primary' },
      );
    });
  };
  // A prompt asks only for what the view did not bind (`validateView` refuses the overlap).
  const ask = (b.prompt ?? []).filter((name) => !Object.hasOwn(b.input ?? {}, name));
  const fp = b.files?.prompt;
  const file = fp
    ? { input: fp.input, label: fp.label ? t(fp.label) : fp.input, value: null }
    : null;
  if (ask.length === 0 && !file) return go({});
  const input = findAction(actions ?? [], host.ext, b.action)?.input;
  const declared = actionInputFields(input);
  // A list or an object the action declares has no prompt input: refused, never sent as text.
  const composite = ask.find(
    (name) =>
      Object.hasOwn(input?.properties ?? {}, name) && !declared.some((f) => f.name === name),
  );
  if (composite) {
    toast.error(m['view.notDrawn']({ kind: composite }));
    return Promise.resolve();
  }
  const fields = ask.map((name) =>
    toFormField(
      declared.find((f) => f.name === name) ?? { name, type: 'text' },
      undefined,
      b.pick && Object.hasOwn(b.pick, name) ? b.pick[name] : undefined,
    ),
  );
  return new Promise<void>((resolve) => {
    prompt = { fields, values: {}, file, go, done: resolve };
  });
}

function remove(collection: string, id: string): Promise<void> {
  settleConfirm();
  return new Promise<void>((resolve) => {
    confirmDone = resolve;
    askConfirm(
      m['ext.confirmDelete'](),
      async () => {
        try {
          await dataApi.delete(collection, id);
          host.version++;
          toast.success(m['common.done']());
        } catch (e) {
          toast.error((e as Error).message || m['common.deleteFailed']());
        } finally {
          settleConfirm();
        }
      },
      { confirmClass: 'btn-error' },
    );
  });
}

async function change(
  c: Change,
  collection: string,
  record: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<boolean> {
  if (c !== 'patch') {
    // The action sees the record as it is after the change (`$record`).
    const input = resolveInput(c.input, { ...host.scope, record: { ...record, ...patch } });
    if (!input) {
      toast.error(m['view.selectFirst']());
      return false;
    }
    return run(c.action, input);
  }
  try {
    if (record.id === undefined || record.id === null)
      await dataApi.create(collection, { ...record, ...patch });
    else await dataApi.update(collection, String(record.id), patch);
    return true;
  } catch (e) {
    toast.error((e as Error).message || m['common.failed']());
    return false;
  } finally {
    host.version++;
  }
}

async function changeMany(
  c: Change,
  collection: string,
  writes: { record: Record<string, unknown>; patch: Record<string, unknown> }[],
): Promise<boolean> {
  if (c !== 'patch') {
    for (const w of writes) if (!(await change(c, collection, w.record, w.patch))) return false;
    return true;
  }
  // The data API's bulk limit: more is refused here, before anything is written.
  if (writes.length > WHOLE) {
    toast.error(m['view.tooMany']({ count: writes.length, max: WHOLE }));
    return false;
  }
  try {
    // All or nothing (ADR 0044): a refused row throws, naming every refused row.
    await dataApi.bulkUpdate(
      collection,
      writes.map((w) => ({ ...w.patch, id: String(w.record.id) })),
    );
    return true;
  } catch (e) {
    toast.error((e as Error).message || m['common.failed']());
    return false;
  } finally {
    host.version++;
  }
}

function closePrompt() {
  const p = prompt;
  prompt = null;
  p?.done();
}

function submitPrompt() {
  const p = prompt;
  if (!p) return;
  const picked = p.file ? fileIds(p.file.value)[0] : undefined;
  if (p.file && !picked) return void toast.error(`${p.file.label}: ${m['common.required']()}`);
  let asked: Record<string, unknown>;
  try {
    asked = formPayload(p.values, p.fields);
  } catch (e) {
    toast.error((e as Error).message);
    return; // the dialog stays open to fix the value
  }
  if (p.file && picked) asked[p.file.input] = picked;
  prompt = null;
  void p.go(asked, picked).finally(p.done);
}

const host = $state<ViewHost>({
  ext: '',
  scope: { params: {}, selected: {}, user: undefined },
  t,
  press,
  run,
  hold,
  remove,
  change,
  changeMany,
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
  onconfirm={runConfirmAction}
  oncancel={() => {
    cancelConfirm();
    settleConfirm();
  }} />

{#if prompt}
  <Modal open={true} size="md" onClose={closePrompt} onSubmit={submitPrompt}>
    {#if prompt.fields.length}
      <SchemaForm formId={`view:${ext}:prompt`} schema={{ id: `view:${ext}:prompt`, fields: prompt.fields.filter((f) => !f.pick) }} bind:values={prompt.values} />
    {/if}
    {#each prompt.fields.filter((f) => f.pick) as f (f.name)}
      {@const fid = `view:${ext}:prompt:${f.name}`}
      <div class="form-control mt-2">
        <label class="label" for={fid}><span class="label-text">{f.label}</span></label>
        <ViewPicker id={fid} collection={String(f.pick)} value={prompt.values[f.name]} onchange={(v) => (prompt!.values[f.name] = v)} />
      </div>
    {/each}
    {#if prompt.file}
      {@const file = prompt.file}
      <div class="form-control mt-2">
        <label class="label" for={`view:${ext}:prompt:file`}><span class="label-text">{file.label}</span></label>
        <ViewFiles id={`view:${ext}:prompt:file`} value={file.value} onchange={(v) => (file.value = Array.isArray(v) ? (v[0] ?? null) : v)} />
      </div>
    {/if}
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
