<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { MessageSquare, Send, LoaderCircle } from '@lucide/svelte';

  let stats = $state<Record<string, number>>({});
  let messages = $state<any[]>([]);
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
        api.get<{ stats: any[] }>('/extensions/sms/stats'),
        api.get<{ messages: any[] }>('/extensions/sms/messages?limit=50'),
        api.get<{ templates: any[] }>('/extensions/sms/templates'),
      ]);
      const agg: Record<string, number> = {};
      for (const s of statsRes.stats ?? []) agg[s.status] = s.count;
      stats = agg;
      messages = msgsRes.messages ?? [];
      templates = tplRes.templates ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load SMS data'); }
    finally { loading = false; }
  }

  async function sendSms() {
    if (!sendTo.trim()) { toast.error('Phone number is required'); return; }
    if (!sendBody.trim() && !sendTemplateId) { toast.error('Body or template is required'); return; }
    sending = true; sendResult = null;
    try {
      const payload: Record<string, unknown> = { provider: sendProvider, to: sendTo.trim() };
      if (sendTemplateId) {
        payload.template_id = sendTemplateId;
        if (sendVariables.trim()) {
          try { payload.variables = JSON.parse(sendVariables); }
          catch { toast.error('Variables must be valid JSON'); sending = false; return; }
        }
      } else {
        payload.body = sendBody.trim();
      }
      const res = await api.post<{ id: string }>('/extensions/sms/send', payload);
      sendResult = { ok: true, msg: `Sent! ID: ${res.id}` };
      sendTo = ''; sendBody = ''; sendTemplateId = ''; sendVariables = '';
      await loadAll();
    } catch (e: any) {
      sendResult = { ok: false, msg: 'Error: ' + (e.message ?? 'Failed to send') };
    } finally { sending = false; }
  }

  async function createTemplate() {
    if (!newTplName.trim() || !newTplBody.trim()) { toast.error('Name and body are required'); return; }
    savingTpl = true;
    try {
      const res = await api.post<{ template: any }>('/extensions/sms/templates', { name: newTplName.trim(), body: newTplBody.trim(), provider: newTplProvider });
      templates = [...templates, res.template];
      newTplName = ''; newTplBody = '';
      toast.success('Template created.');
    } catch (e: any) { toast.error('Failed: ' + (e.message ?? '')); }
    finally { savingTpl = false; }
  }

  function statusBadge(s: string) { return ({ sent: 'badge-success', delivered: 'badge-success', failed: 'badge-error', pending: 'badge-warning' } as any)[s] ?? 'badge-ghost'; }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-xl font-semibold flex items-center gap-2"><MessageSquare size={20} /> SMS / Notifications</h1>
    <p class="text-sm text-base-content/50">Send messages and manage templates</p>
  </div>

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
        <h2 class="font-medium text-sm">Send SMS</h2>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Provider</span></label>
            <select class="select select-sm" bind:value={sendProvider}><option value="twilio">Twilio</option><option value="vonage">Vonage</option></select>
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">To number</span></label>
            <input type="tel" class="input input-sm" bind:value={sendTo} placeholder="+1234567890" />
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Template (optional)</span></label>
            <select class="select select-sm" bind:value={sendTemplateId}>
              <option value="">— Custom message —</option>
              {#each templates as tpl}<option value={tpl.id}>{tpl.name}</option>{/each}
            </select>
          </div>
          <div class="form-control">
            {#if sendTemplateId}
              <label class="label py-0"><span class="label-text text-xs">Variables (JSON)</span></label>
              <input class="input input-sm font-mono" bind:value={sendVariables} placeholder={'{"name": "John"}'} />
            {:else}
              <label class="label py-0"><span class="label-text text-xs">Message body</span></label>
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
      <h2 class="font-medium text-sm mb-3">Message Log</h2>
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>To</th><th>Body</th><th>Provider</th><th>Status</th><th>Sent at</th></tr></thead>
          <tbody>
            {#if messages.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">No messages yet.</td></tr>
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
      <h2 class="font-medium text-sm mb-3">Templates</h2>
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
          <h3 class="font-medium text-sm">New Template</h3>
          <div class="grid grid-cols-2 gap-3">
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Name</span></label><input class="input input-sm" bind:value={newTplName} /></div>
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Provider</span></label>
              <select class="select select-sm" bind:value={newTplProvider}><option value="twilio">Twilio</option><option value="vonage">Vonage</option></select>
            </div>
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Body (use {"{{variable}}"} for interpolation)</span></label><textarea class="textarea textarea-sm" bind:value={newTplBody} rows="2" placeholder={"Hello {{name}}, your code is {{code}}"}></textarea></div>
          <div><button class="btn btn-primary btn-sm" onclick={createTemplate} disabled={savingTpl}>
            {#if savingTpl}<LoaderCircle size={13} class="animate-spin" />{/if} Save Template
          </button></div>
        </div>
      </div>
    </div>
  {/if}
</div>
