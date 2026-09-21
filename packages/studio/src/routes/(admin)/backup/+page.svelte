<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { onDestroy, onMount } from 'svelte';
import { api } from '$lib/api.js';
import { ENGINE_URL } from '$lib/config.js';
// The shared formatter, which reads the instance's locale, timezone and
// date_format settings. The local copy this replaces was hardcoded to 'en-US',
// so backup timestamps were the one date on the admin that ignored them.
import { fmtDateTime } from '$lib/stores/format.svelte.js';
import {
  DatabaseBackup,
  Download,
  Trash2,
  RefreshCw,
  LoaderCircle,
  Clock,
  CheckCircle,
  XCircle,
} from '@lucide/svelte';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import CrudListPage from '$lib/components/common/CrudListPage.svelte';
import { toast } from '$lib/stores/toast.svelte.js';

interface Backup {
  id: string;
  filename: string;
  size_bytes: number | null;
  size_human: string | null;
  status: 'in_progress' | 'completed' | 'failed';
  error: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

let backups = $state<Backup[]>([]);
let loading = $state(true);
let creating = $state(false);
let notes = $state('');
let showModal = $state(false);
let pollingIds = $state<Set<string>>(new Set());
let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });

onMount(loadBackups);

// Every poller, so leaving the page stops them. Without this a backup that is
// still running leaves a 3-second request to the engine going for as long as
// the tab lives, on a page the operator navigated away from.
const timers = new Set<ReturnType<typeof setInterval>>();
onDestroy(() => {
  for (const t of timers) clearInterval(t);
  timers.clear();
});

async function loadBackups() {
  loading = true;
  try {
    const data = await api.get<{ backups: Backup[] }>('/api/backup');
    backups = data.backups || [];
    for (const b of backups) {
      if (b.status === 'in_progress' && !pollingIds.has(b.id)) {
        pollBackup(b.id);
      }
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  } catch (e: any) {
    toast.error(e.message ?? m['bk.loadFailed']());
  } finally {
    loading = false;
  }
}

async function createBackup() {
  creating = true;
  try {
    const data = await api.post<{ backup_id: string; filename: string }>('/api/backup', {
      notes: notes.trim() || undefined,
    });
    showModal = false;
    notes = '';
    await loadBackups();
    pollBackup(data.backup_id);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  } catch (e: any) {
    toast.error(e.message ?? m['bk.createFailed']());
  } finally {
    creating = false;
  }
}

function pollBackup(id: string) {
  if (pollingIds.has(id)) return;
  pollingIds = new Set([...pollingIds, id]);

  const interval = setInterval(async () => {
    try {
      const status = await api.get<{
        status: string;
        size_human: string | null;
        error: string | null;
      }>(`/api/backup/${id}/status`);
      if (status.status !== 'in_progress') {
        clearInterval(interval);
        pollingIds = new Set([...pollingIds].filter((x) => x !== id));
        await loadBackups();
      }
    } catch {
      clearInterval(interval);
      pollingIds = new Set([...pollingIds].filter((x) => x !== id));
    }
  }, 3000);
  timers.add(interval);
}

async function deleteBackup(id: string, filename: string) {
  confirmState = {
    open: true,
    title: m['confirm.deleteBackup.title'](),
    message: m['bk.deleteMsg']({ filename }),
    confirmLabel: m['common.delete'](),
    onconfirm: async () => {
      confirmState.open = false;
      try {
        await api.delete(`/api/backup/${id}`);
        backups = backups.filter((b) => b.id !== id);
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      } catch (e: any) {
        toast.error(e.message ?? m['bk.deleteFailed']());
      }
    },
  };
}

function downloadBackup(id: string) {
  // Absolute, against the engine. The relative path this used resolved against
  // the Studio's own origin, which is only the engine's when the Studio is the
  // embedded one at <engine>/admin. Built with `VITE_ENGINE_URL`, or running in
  // the Capacitor shell that points at a self-hosted instance, the browser
  // asked the Studio's host for `/api/backup/…` and opened a blank tab.
  window.open(`${ENGINE_URL}/api/backup/${id}/download`, '_blank');
}
</script>

<CrudListPage
  title={m['bk.title']()}
  subtitle={m['bk.subtitle']()}
  count={backups.length}
  {loading}
  actionLabel={m['bk.newBackup']()}
  onAction={() => (showModal = true)}
  empty={{
    illustration: 'table',
    illustrationColor: 'text-info',
    title: m['bk.emptyTitle'](),
    description: m['bk.emptyDesc'](),
    actionLabel: m['bk.createBackup'](),
    onAction: () => (showModal = true),
  }}
>
  {#snippet headerExtras()}
    <div class="flex justify-end">
      <button class="btn btn-ghost btn-sm gap-2" onclick={loadBackups} disabled={loading} aria-label={m['bk.refreshAria']()}>
        <RefreshCw size={16} class={loading ? 'animate-spin' : ''} />
        {m['common.refresh']()}
      </button>
    </div>
  {/snippet}

  {#snippet list()}
    <div class="space-y-3">
 {#each backups as backup}
 <div class="flex items-center gap-4 p-3 border border-base-200 rounded-xl hover:bg-base-50 transition-colors">
 <div class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0
 {backup.status === 'completed' ? 'bg-success/10' : backup.status === 'failed' ? 'bg-error/10' : 'bg-warning/10'}">
 {#if backup.status === 'completed'}
 <CheckCircle size={20} class="text-success" />
 {:else if backup.status === 'in_progress'}
 <LoaderCircle size={20} class="text-warning animate-spin" />
 {:else}
 <XCircle size={20} class="text-error" />
 {/if}
 </div>
 <div class="flex-1 min-w-0">
 <div class="flex items-center gap-2 flex-wrap">
 <span class="font-medium text-sm">{fmtDateTime(backup.created_at)}</span>
 <span class="badge badge-xs {backup.status === 'completed' ? 'badge-success' : backup.status === 'failed' ? 'badge-error' : 'badge-warning'}">{backup.status === 'completed' ? m['bk.status.completed']() : backup.status === 'failed' ? m['bk.status.failed']() : m['bk.status.inProgress']()}</span>
 </div>
 <div class="text-xs text-base-content/65 mt-0.5 font-mono truncate">
 {backup.filename}
 {#if backup.size_human} · {backup.size_human}{/if}
 {#if backup.notes} · {backup.notes}{/if}
 </div>
 </div>
 <div class="flex gap-2 shrink-0">
 {#if backup.status === 'completed'}
 <button class="btn btn-ghost btn-xs" onclick={() => downloadBackup(backup.id)} title={m['common.download']()}>
 <Download size={13} />
 </button>
 {/if}
 <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteBackup(backup.id, backup.filename)}>
 <Trash2 size={13} />
 </button>
 </div>
 </div>
 {/each}
    </div>
  {/snippet}
</CrudListPage>

<!-- Create Backup Modal -->
{#if showModal}
 <div class="modal modal-open">
 <div class="modal-box max-w-md">
 <h3 class="font-bold text-lg mb-4">{m['bk.newBackup']()}</h3>
 <div class="form-control">
 <label class="label" for="backup-notes"><span class="label-text">{m['bk.notesOptional']()}</span></label>
 <input id="backup-notes" class="input" bind:value={notes} placeholder={m['bk.notesPh']()} />
 </div>
 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showModal = false)}>{m['common.cancel']()}</button>
 <button class="btn btn-primary" onclick={createBackup} disabled={creating}>
 {#if creating}<LoaderCircle size={16} class="animate-spin" />{/if}
 {m['bk.startBackup']()}
 </button>
 </div>
 </div>
 <div
 class="modal-backdrop"
 role="button"
 tabindex="0"
 aria-label={m['common.close']()}
 onclick={() => (showModal = false)}
 onkeydown={(e) => { if (e.key === 'Escape') showModal = false; }}
 ></div>
 </div>
{/if}

<ConfirmModal
 open={confirmState.open}
 title={confirmState.title}
 message={confirmState.message}
 confirmLabel={confirmState.confirmLabel ?? m['common.confirm']()}
 onconfirm={confirmState.onconfirm}
 oncancel={() => (confirmState.open = false)}
/>
