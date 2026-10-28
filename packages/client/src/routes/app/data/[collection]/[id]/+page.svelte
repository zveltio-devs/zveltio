<script lang="ts">
import { goto, invalidateAll } from '$app/navigation';
import { m } from '#lib/i18n.svelte.js';
import { fromInput, inputKind, isWritable, toInput } from '#lib/workspace/fields.js';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();

const base = $derived(`/app/data/${encodeURIComponent(data.collection.name)}`);
const api = $derived(`${data.engineUrl}/api/data/${encodeURIComponent(data.collection.name)}`);
const fields = $derived(
  data.collection.fields.map((f) => ({ ...f, kind: inputKind(f.type), writable: isWritable(f) })),
);

/** The inputs, seeded from the record each time the page loads one. */
let values = $state<Record<string, string | boolean>>({});
$effect(() => {
  values = Object.fromEntries(fields.map((f) => [f.name, toInput(f.kind, data.record?.[f.name])]));
});
let saving = $state(false);
let problem = $state<string | null>(null);

async function send(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.detail ?? json?.error ?? `HTTP ${res.status}`);
  return json as { id?: string } | null;
}

async function save(e: SubmitEvent) {
  e.preventDefault();
  saving = true;
  problem = null;
  try {
    const body: Record<string, unknown> = {};
    for (const f of fields) {
      if (!f.writable) continue;
      const value = fromInput(f.kind, values[f.name] ?? '', f.name);
      // A new record sends what was filled in; an existing one, what changed.
      const before = data.record
        ? fromInput(f.kind, toInput(f.kind, data.record[f.name]), f.name)
        : null;
      if (JSON.stringify(value) !== JSON.stringify(before)) body[f.name] = value;
    }
    if (data.record) {
      await send('PATCH', `${api}/${encodeURIComponent(data.record.id)}`, body);
      await invalidateAll();
    } else {
      const created = await send('POST', api, body);
      await goto(created?.id ? `${base}/${encodeURIComponent(created.id)}` : base);
    }
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  } finally {
    saving = false;
  }
}

async function remove() {
  if (!data.record || !confirm(m['data.confirm_delete']())) return;
  try {
    await send('DELETE', `${api}/${encodeURIComponent(data.record.id)}`);
    await goto(base);
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
}
</script>

<div class="max-w-2xl space-y-4">
  <div class="breadcrumbs text-sm">
    <ul>
      <li><a href={base}>{data.collection.display_name ?? data.collection.name}</a></li>
      <li>{data.record ? data.record.id : m['data.new']()}</li>
    </ul>
  </div>

  {#if problem}<div role="alert" class="alert alert-error">{problem}</div>{/if}

  <form onsubmit={save} class="card bg-base-100 shadow">
    <div class="card-body gap-3">
      {#each fields as f (f.name)}
        {@const id = `f-${f.name}`}
        {#if f.kind === 'checkbox'}
          <label class="label gap-2" for={id}>
            <input {id} type="checkbox" class="checkbox" disabled={!f.writable} bind:checked={values[f.name] as boolean} />
            {f.label ?? f.name}
          </label>
        {:else}
          <label class="floating-label" for={id}>
            <span>{f.label ?? f.name}{f.required ? ' *' : ''}</span>
            {#if f.kind === 'textarea' || f.kind === 'json'}
              <textarea {id} class="textarea w-full" class:font-mono={f.kind === 'json'} rows="4"
                readonly={!f.writable} placeholder={f.label ?? f.name} bind:value={values[f.name] as string}></textarea>
            {:else}
              <input {id} type={f.kind} step={f.kind === 'number' ? 'any' : f.kind === 'datetime-local' || f.kind === 'time' ? '1' : undefined} class="input w-full"
                readonly={!f.writable} required={f.required && f.writable && !data.record}
                placeholder={f.label ?? f.name} bind:value={values[f.name] as string} />
            {/if}
          </label>
          {#if f.description}<p class="text-xs text-base-content/60 -mt-2">{f.description}</p>{/if}
        {/if}
      {/each}

      <div class="card-actions justify-between mt-2">
        {#if data.record}
          <button type="button" class="btn btn-ghost text-error" onclick={remove}>{m['data.delete']()}</button>
        {:else}<span></span>{/if}
        <button class="btn btn-primary" disabled={saving}>{saving ? m['common.saving']() : m['common.save']()}</button>
      </div>
    </div>
  </form>
</div>
