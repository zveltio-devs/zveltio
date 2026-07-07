<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { MessageSquare, Send, LoaderCircle } from '@lucide/svelte';

let stats = $state<Record<string, number>>({});
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let messages = $state<any[]>([]);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let templates = $state<any[]>([]);
let loading = $state(true);

let sendProvider = $state<'twilio' | 'vonage'>('twilio');
let sendTo = $state('');
let sendBody = $state('');
let sendTemplateId = $state('');
let sendVariables = $state('');
let sending = $state(false);
let sendResult = $state<{ ok: boolean; msg: string } | null>(null);

let newTplName = $state('');
let newTplBody = $state('');
let newTplProvider = $state<'twilio' | 'vonage'>('twilio');
let savingTpl = $state(false);

let sentToday = $derived(
  messages.filter((m) => {
    const d = new Date(m.created_at);
    return d.toDateString() === new Date().toDateString();
  }).length,
);

onMount(loadAll);

async function loadAll() {
  loading = true;
  try {
    const [statsRes, msgsRes, tplRes] = await Promise.all([
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      api.get<{ stats: any[] }>('/extensions/sms/stats'),
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      api.get<{ messages: any[] }>('/extensions/sms/messages?limit=50'),
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      api.get<{ templates: any[] }>('/extensions/sms/templates'),
    ]);
    const agg: Record<string, number> = {};
    for (const s of statsRes.stats ?? []) agg[s.status] = s.count;
    stats = agg;
    messages = msgsRes.messages ?? [];
    templates = tplRes.templates ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}

async function sendSms() {
  if (!sendTo.trim()) {
    toast.error(m['sms.error.phoneRequired']());
    return;
  }
  if (!sendBody.trim() && !sendTemplateId) {
    toast.error(m['sms.error.bodyRequired']());
    return;
  }
  sending = true;
  sendResult = null;
  try {
    const payload: Record<string, unknown> = { provider: sendProvider, to: sendTo.trim() };
    if (sendTemplateId) {
      payload.template_id = sendTemplateId;
      if (sendVariables.trim()) {
        try {
          payload.variables = JSON.parse(sendVariables);
        } catch {
          toast.error(m['sms.error.variablesJson']());
          sending = false;
          return;
        }
      }
    } else {
      payload.body = sendBody.trim();
    }
    const res = await api.post<{ id: string }>('/extensions/sms/send', payload);
    sendResult = { ok: true, msg: `Sent! ID: ${res.id}` };
    sendTo = '';
    sendBody = '';
    sendTemplateId = '';
    sendVariables = '';
    await loadAll();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    sendResult = { ok: false, msg: 'Error: ' + (e.message ?? 'Failed to send') };
  } finally {
    sending = false;
  }
}

async function createTemplate() {
  if (!newTplName.trim() || !newTplBody.trim()) {
    toast.error(m['sms.error.nameBodyRequired']());
    return;
  }
  savingTpl = true;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const res = await api.post<{ template: any }>('/extensions/sms/templates', {
      name: newTplName.trim(),
      body: newTplBody.trim(),
      provider: newTplProvider,
    });
    templates = [...templates, res.template];
    newTplName = '';
    newTplBody = '';
    toast.success(m['ext.created']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(m['ext.errorPrefix']() + (e.message ?? ''));
  } finally {
    savingTpl = false;
  }
}

function statusBadge(s: string) {
  return (
    (
      {
        sent: 'badge-success',
        delivered: 'badge-success',
        failed: 'badge-error',
        pending: 'badge-warning',
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } as any
    )[s] ?? 'badge-ghost'
  );
}
</script>

<ExtensionPageShell title={m['sms.title']()} subtitle={m['sms.subtitle']()}>
  <div class="space-y-6">
  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="stats shadow w-full">
      {#each [{ label: 'Sent Today', value: sentToday }, { label: 'Delivered (7d)', value: stats.delivered ?? 0 }, { label: 'Failed (7d)', value: stats.failed ?? 0 }, { label: 'Pending (7d)', value: stats.pending ?? 0 }] as card}
        <div class="stat"><div class="stat-title">{card.label}</div><div class="stat-value text-2xl">{card.value}</div></div>
      {/each}
    </div>

    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-4 gap-3">
        <h2 class="font-medium text-sm">{m['sms.ui.send_sms']()}</h2>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['search.ui.provider']()}</span></label>
            <select class="select select-sm" bind:value={sendProvider}><option value="twilio">{m['sms.ui.twilio']()}</option><option value="vonage">{m['sms.ui.vonage']()}</option></select>
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['sms.ui.to_number']()}</span></label>
            <input type="tel" class="input input-sm" bind:value={sendTo} placeholder={m['sms.ui.1234567890']()} />
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['sms.ui.template_optional']()}</span></label>
            <select class="select select-sm" bind:value={sendTemplateId}>
              <option value="">{m['sms.ui.custom_message']()}</option>
              {#each templates as tpl}<option value={tpl.id}>{tpl.name}</option>{/each}
            </select>
          </div>
          <div class="form-control">
            {#if sendTemplateId}
              <label class="label py-0"><span class="label-text text-xs">{m['sms.ui.variables_json']()}</span></label>
              <input class="input input-sm font-mono" bind:value={sendVariables} placeholder={'{"name": "John"}'} />
            {:else}
              <label class="label py-0"><span class="label-text text-xs">{m['sms.ui.message_body']()}</span></label>
              <textarea class="textarea textarea-sm" bind:value={sendBody} rows="2" maxlength="1600"></textarea>
            {/if}
          </div>
        </div>
        <div class="flex items-center gap-3">
          <button class="btn btn-primary btn-sm gap-1" onclick={sendSms} disabled={sending}>
            {#if sending}<LoaderCircle size={14} class="animate-spin" />{:else}<Send size={14} />{/if} Send SMS
          </button>
          {#if sendResult}<span class="text-sm {sendResult.ok ? 'text-success' : 'text-error'}">{sendResult.msg}</span>{/if}
        </div>
      </div>
    </div>

    <div>
      <h2 class="font-medium text-sm mb-3">{m['sms.ui.message_log']()}</h2>
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>{m['common.col.to']()}</th><th>{m['sms.col.body']()}</th><th>{m['common.col.provider']()}</th><th>{m['common.col.status']()}</th><th>{m['sms.col.sentAt']()}</th></tr></thead>
          <tbody>
            {#if messages.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">{m['sms.ui.no_messages_yet']()}</td></tr>
            {:else}{#each messages as msg (msg.id)}
              <tr class="hover">
                <td class="font-mono text-xs">{msg.to_number}</td>
                <td class="text-sm max-w-xs truncate">{msg.body?.slice(0, 60)}{(msg.body?.length ?? 0) > 60 ? '…' : ''}</td>
                <td class="text-sm">{msg.provider}</td>
                <td><span class="badge {statusBadge(msg.status)} badge-sm">{msg.status}</span></td>
                <td class="text-xs text-base-content/60">{msg.sent_at ? new Date(msg.sent_at).toLocaleString() : '—'}</td>
              </tr>
            {/each}{/if}
          </tbody>
        </table>
      </div>
    </div>

    <div>
      <h2 class="font-medium text-sm mb-3">{m['ai.tab.templates']()}</h2>
      <div class="space-y-2 mb-4">
        {#each templates as tpl (tpl.id)}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-3 flex-row items-start gap-3">
              <div class="flex-1">
                <div class="flex items-center gap-2"><span class="font-medium text-sm">{tpl.name}</span><span class="badge badge-ghost badge-xs">{tpl.provider}</span></div>
                <code class="text-xs text-base-content/70 block mt-1">{tpl.body}</code>
              </div>
            </div>
          </div>
        {/each}
      </div>

      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-4 gap-3">
          <h3 class="font-medium text-sm">{m['sms.ui.new_template']()}</h3>
          <div class="grid grid-cols-2 gap-3">
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['common.col.name']()}</span></label><input class="input input-sm" bind:value={newTplName} /></div>
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['sms.col.provider']()}</span></label>
              <select class="select select-sm" bind:value={newTplProvider}><option value="twilio">{m['sms.ui.twilio']()}</option><option value="vonage">{m['sms.ui.vonage']()}</option></select>
            </div>
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['sms.placeholder.body']()}</span></label><textarea class="textarea textarea-sm" bind:value={newTplBody} rows="2" placeholder={"Hello {{name}}, your code is {{code}}"}></textarea></div>
          <div><button class="btn btn-primary btn-sm" onclick={createTemplate} disabled={savingTpl}>
            {#if savingTpl}<LoaderCircle size={13} class="animate-spin" />{/if} {m['sms.btn.saveTemplate']()}
          </button></div>
        </div>
      </div>
    </div>
  {/if}
  </div>
</ExtensionPageShell>
