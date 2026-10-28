<script lang="ts">
import { goto, invalidateAll } from '$app/navigation';
import CollectionForm from '@zveltio/ui/CollectionForm.svelte';
import { toast } from '@zveltio/ui/toast';
import { m } from '#lib/i18n.svelte.js';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();

const base = $derived(`/app/data/${encodeURIComponent(data.collection.name)}`);
const api = $derived(`${data.engineUrl}/api/data/${encodeURIComponent(data.collection.name)}`);

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

async function save(body: Record<string, unknown>) {
  if (data.record) {
    await send('PATCH', `${api}/${encodeURIComponent(data.record.id)}`, body);
    await invalidateAll();
    toast.show(m['data.saved'](), 'success');
  } else {
    const created = await send('POST', api, body);
    await goto(created?.id ? `${base}/${encodeURIComponent(created.id)}` : base);
  }
}

async function remove() {
  if (!data.record || !confirm(m['data.confirm_delete']())) return;
  await send('DELETE', `${api}/${encodeURIComponent(data.record.id)}`);
  await goto(base);
}
</script>

<div class="max-w-2xl space-y-4">
  <div class="breadcrumbs text-sm">
    <ul>
      <li><a href={base}>{data.collection.display_name ?? data.collection.name}</a></li>
      <li>{data.record ? data.record.id : m['data.new']()}</li>
    </ul>
  </div>

  <CollectionForm
    collection={data.collection}
    record={data.record}
    onSave={save}
    onDelete={data.record ? remove : null}
    labels={{
      save: m['common.save'](),
      saving: m['common.saving'](),
      delete: m['data.delete'](),
      notANumber: (field) => m['data.not_a_number']({ field }),
      invalidJson: (field) => m['data.invalid_json']({ field }),
    }}
  />
</div>
