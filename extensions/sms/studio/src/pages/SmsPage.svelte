<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  let stats = $state<Record<string, number>>({});
  let messages = $state<any[]>([]);
  let templates = $state<any[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Send form
  let sendProvider = $state<'twilio' | 'vonage'>('twilio');
  let sendTo = $state('');
  let sendBody = $state('');
  let sendTemplateId = $state('');
  let sendVariables = $state('');
  let sending = $state(false);
  let sendResult = $state<string | null>(null);

  // New template form
  let newTplName = $state('');
  let newTplBody = $state('');
  let newTplProvider = $state<'twilio' | 'vonage'>('twilio');
  let savingTpl = $state(false);

  let sentToday = $derived(
    messages.filter((m) => {
      const d = new Date(m.created_at);
      const today = new Date();
      return d.toDateString() === today.toDateString();
    }).length,
  );

  onMount(async () => {
    await loadAll();
  });

  async function loadAll() {
    loading = true;
    try {
      const [statsRes, msgsRes, tplRes] = await Promise.all([
        api.get('/extensions/sms/stats'),
        api.get('/extensions/sms/messages?limit=50'),
        api.get('/extensions/sms/templates'),
      ]);

      const statsArr: Array<{ status: string; count: number }> = statsRes.stats ?? [];
      const agg: Record<string, number> = {};
      for (const s of statsArr) agg[s.status] = s.count;
      stats = agg;

      messages = msgsRes.messages ?? [];
      templates = tplRes.templates ?? [];
    } catch (e: any) {
      error = e.message ?? 'Failed to load SMS data';
    } finally {
      loading = false;
    }
  }

  async function sendSms() {
    if (!sendTo.trim()) return alert('Phone number is required');
    if (!sendBody.trim() && !sendTemplateId) return alert('Body or template is required');
    sending = true;
    sendResult = null;
    try {
      const payload: Record<string, unknown> = {
        provider: sendProvider,
        to: sendTo.trim(),
      };
      if (sendTemplateId) {
        payload.template_id = sendTemplateId;
        if (sendVariables.trim()) {
          try {
            payload.variables = JSON.parse(sendVariables);
          } catch {
            return alert('Variables must be valid JSON, e.g. {"name": "John"}');
          }
        }
      } else {
        payload.body = sendBody.trim();
      }

      const res = await api.post('/extensions/sms/send', payload);
      sendResult = `Sent! ID: ${res.id}`;
      sendTo = '';
      sendBody = '';
      sendTemplateId = '';
      sendVariables = '';
      await loadAll();
    } catch (e: any) {
      sendResult = 'Error: ' + (e.message ?? 'Failed to send');
    } finally {
      sending = false;
    }
  }

  async function createTemplate() {
    if (!newTplName.trim() || !newTplBody.trim()) return alert('Name and body are required');
    savingTpl = true;
    try {
      const res = await api.post('/extensions/sms/templates', {
        name: newTplName.trim(),
        body: newTplBody.trim(),
        provider: newTplProvider,
      });
      templates = [...templates, res.template];
      newTplName = '';
      newTplBody = '';
    } catch (e: any) {
      alert('Failed to create template: ' + (e.message ?? ''));
    } finally {
      savingTpl = false;
    }
  }

  function statusColor(status: string): string {
    const map: Record<string, string> = {
      sent: '#22c55e',
      delivered: '#16a34a',
      failed: '#ef4444',
      pending: '#f59e0b',
    };
    return map[status] ?? '#6b7280';
  }
</script>

<div class="sms-page">
  <h1>SMS / Notifications</h1>

  {#if loading}
    <p class="loading">Loading…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else}
    <!-- Stats cards -->
    <section class="stats-section">
      {#each [
        { label: 'Sent Today', value: sentToday, color: '#6366f1' },
        { label: 'Delivered (7d)', value: stats.delivered ?? 0, color: '#22c55e' },
        { label: 'Failed (7d)', value: stats.failed ?? 0, color: '#ef4444' },
        { label: 'Pending (7d)', value: stats.pending ?? 0, color: '#f59e0b' },
      ] as card}
        <div class="stat-card">
          <div class="stat-value" style="color: {card.color}">{card.value}</div>
          <div class="stat-label">{card.label}</div>
        </div>
      {/each}
    </section>

    <!-- Send SMS form -->
    <section class="send-section">
      <h2>Send SMS</h2>
      <div class="send-form">
        <div class="form-row">
          <label>Provider
            <select bind:value={sendProvider}>
              <option value="twilio">Twilio</option>
              <option value="vonage">Vonage</option>
            </select>
          </label>
          <label>To Number
            <input type="tel" bind:value={sendTo} placeholder="+1234567890" />
          </label>
        </div>
        <div class="form-row">
          <label>Template (optional)
            <select bind:value={sendTemplateId}>
              <option value="">— Custom message —</option>
              {#each templates as tpl}
                <option value={tpl.id}>{tpl.name}</option>
              {/each}
            </select>
          </label>
          {#if sendTemplateId}
            <label>Variables (JSON)
              <input type="text" bind:value={sendVariables} placeholder='&#123;"name": "John"&#125;' />
            </label>
          {:else}
            <label>Message Body
              <textarea bind:value={sendBody} rows="3" placeholder="Your message here…" maxlength="1600"></textarea>
            </label>
          {/if}
        </div>
        <button class="btn-send" onclick={sendSms} disabled={sending}>
          {sending ? 'Sending…' : 'Send SMS'}
        </button>
        {#if sendResult}
          <p class="send-result" class:success={!sendResult.startsWith('Error')}>{sendResult}</p>
        {/if}
      </div>
    </section>

    <!-- Message log -->
    <section class="messages-section">
      <h2>Message Log</h2>
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>To</th>
              <th>Body</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Sent At</th>
            </tr>
          </thead>
          <tbody>
            {#each messages as msg}
              <tr>
                <td class="number">{msg.to_number}</td>
                <td class="body-preview" title={msg.body}>{msg.body.slice(0, 60)}{msg.body.length > 60 ? '…' : ''}</td>
                <td>{msg.provider}</td>
                <td>
                  <span class="status-badge" style="color: {statusColor(msg.status)}; background: {statusColor(msg.status)}1a">
                    {msg.status}
                  </span>
                </td>
                <td class="time">{msg.sent_at ? new Date(msg.sent_at).toLocaleString() : '—'}</td>
              </tr>
            {:else}
              <tr><td colspan="5" class="empty">No messages yet.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <!-- Templates -->
    <section class="templates-section">
      <h2>Templates</h2>
      {#each templates as tpl}
        <div class="tpl-card">
          <div class="tpl-header">
            <strong>{tpl.name}</strong>
            <span class="tpl-provider">{tpl.provider}</span>
          </div>
          <code class="tpl-body">{tpl.body}</code>
        </div>
      {/each}

      <div class="new-tpl-form">
        <h3>New Template</h3>
        <div class="form-row">
          <label>Name <input type="text" bind:value={newTplName} placeholder="Template name" /></label>
          <label>Provider
            <select bind:value={newTplProvider}>
              <option value="twilio">Twilio</option>
              <option value="vonage">Vonage</option>
            </select>
          </label>
        </div>
        <label>Body (use &#123;&#123;variable&#125;&#125; for interpolation)
          <textarea bind:value={newTplBody} rows="3" placeholder="Hello {{name}}, your code is {{code}}"></textarea>
        </label>
        <button class="btn-save-tpl" onclick={createTemplate} disabled={savingTpl}>
          {savingTpl ? 'Saving…' : 'Save Template'}
        </button>
      </div>
    </section>
  {/if}
</div>

<style>
  .sms-page { max-width: 1100px; margin: 0 auto; padding: 2rem; }
  h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 1.5rem; }
  h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; }
  h3 { font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; }
  section { margin-bottom: 2rem; }
  .loading { color: #6b7280; }
  .error { color: #ef4444; }
  .stats-section { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }
  .stat-card { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1.25rem; text-align: center; }
  .stat-value { font-size: 2rem; font-weight: 700; }
  .stat-label { font-size: 0.8rem; color: #6b7280; margin-top: 0.25rem; }
  .send-form { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1.25rem; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 0.875rem; font-weight: 500; color: #374151; }
  input, select, textarea {
    padding: 0.4rem 0.6rem; border: 1px solid #e5e7eb; border-radius: 6px;
    font-size: 0.875rem; width: 100%; box-sizing: border-box;
  }
  .btn-send {
    padding: 0.5rem 1.25rem; background: #6366f1; color: white; border: none;
    border-radius: 6px; cursor: pointer; font-weight: 500;
  }
  .btn-send:hover:not(:disabled) { background: #4f46e5; }
  .btn-send:disabled { opacity: 0.6; cursor: not-allowed; }
  .send-result { margin-top: 0.5rem; font-size: 0.875rem; color: #ef4444; }
  .send-result.success { color: #22c55e; }
  .table-wrapper { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th { text-align: left; padding: 0.6rem 0.75rem; background: #f9fafb; border-bottom: 2px solid #e5e7eb; font-weight: 600; }
  td { padding: 0.6rem 0.75rem; border-bottom: 1px solid #f3f4f6; }
  .number { font-family: monospace; }
  .body-preview { max-width: 300px; }
  .status-badge { padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
  .time { font-size: 0.8rem; color: #9ca3af; white-space: nowrap; }
  .empty { text-align: center; color: #9ca3af; }
  .tpl-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 0.75rem; margin-bottom: 0.5rem; }
  .tpl-header { display: flex; justify-content: space-between; margin-bottom: 0.25rem; }
  .tpl-provider { font-size: 0.75rem; color: #6b7280; }
  .tpl-body { display: block; font-size: 0.8rem; color: #374151; white-space: pre-wrap; }
  .new-tpl-form { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; margin-top: 1rem; }
  .btn-save-tpl {
    margin-top: 0.75rem; padding: 0.4rem 1rem; background: #6366f1; color: white;
    border: none; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 0.875rem;
  }
  .btn-save-tpl:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
