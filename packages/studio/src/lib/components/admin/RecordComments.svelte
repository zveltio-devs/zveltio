<script lang="ts">
 import { onMount } from 'svelte';
 import { api } from '$lib/api.js';
 import Send from '@lucide/svelte/icons/send.svelte';
 import Trash2 from '@lucide/svelte/icons/trash-2.svelte';
 import AtSign from '@lucide/svelte/icons/at-sign.svelte';

 interface Comment {
 id: string;
 content: string;
 user_id: string;
 user_name: string | null;
 user_email: string | null;
 created_at: string;
 updated_at: string | null;
 }

 interface User { id: string; name: string; email: string; }

 let {
 collection,
 recordId,
 currentUserId,
 }: { collection: string; recordId: string; currentUserId: string } = $props();

 let comments = $state<Comment[]>([]);
 let users = $state<User[]>([]);
 let loading = $state(true);
 let error = $state<string | null>(null);
 let newComment = $state('');
 let sending = $state(false);
 let showMentions = $state(false);
 let mentionFilter = $state('');

 onMount(() => { loadComments(); loadUsers(); });

 async function loadComments() {
 loading = true;
 error = null;
 try {
 const data = await api.get<{ comments: Comment[] }>(`/api/revisions/${collection}/${recordId}/comments`);
 comments = data.comments || [];
 } catch (e) {
 error = e instanceof Error ? e.message : 'Failed to load';
 } finally {
 loading = false;
 }
 }

 async function loadUsers() {
 try {
 const data = await api.get<{ users: User[] }>('/api/users?limit=50');
 users = data.users || [];
 } catch { /* non-critical */ }
 }

 async function sendComment() {
 if (!newComment.trim()) return;
 sending = true;
 error = null;
 try {
 await api.post(`/api/revisions/${collection}/${recordId}/comments`, { content: newComment });
 newComment = '';
 await loadComments();
 } catch (e) {
 error = e instanceof Error ? e.message : 'Failed to send';
 } finally {
 sending = false;
 }
 }

 async function deleteComment(id: string) {
 if (!confirm('Delete this comment?')) return;
 try {
 await api.delete(`/api/revisions/${collection}/${recordId}/comments/${id}`);
 await loadComments();
 } catch (e) {
 error = e instanceof Error ? e.message : 'Failed to delete';
 }
 }

 function formatDate(iso: string) {
 return new Date(iso).toLocaleString('en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
 }

 function getInitials(comment: Comment): string {
 const name = comment.user_name || comment.user_email || 'U';
 return name.substring(0, 2).toUpperCase();
 }

 function handleInput(e: Event) {
 const input = e.target as HTMLTextAreaElement;
 const textBeforeCursor = input.value.substring(0, input.selectionStart);
 const lastAt = textBeforeCursor.lastIndexOf('@');
 if (lastAt !== -1) {
 const afterAt = textBeforeCursor.substring(lastAt + 1);
 if (!afterAt.includes(' ') && afterAt.length < 20) {
 mentionFilter = afterAt.toLowerCase();
 showMentions = true;
 return;
 }
 }
 showMentions = false;
 }

 function insertMention(user: User) {
 const el = document.activeElement as HTMLTextAreaElement;
 const cursorPos = el?.selectionStart || 0;
 const textBeforeCursor = newComment.substring(0, cursorPos);
 const lastAt = textBeforeCursor.lastIndexOf('@');
 if (lastAt !== -1) {
 newComment = `${newComment.substring(0, lastAt)}@${user.name} ${newComment.substring(cursorPos)}`;
 }
 showMentions = false;
 }

 function getFilteredUsers(): User[] {
 if (!mentionFilter) return users.slice(0, 5);
 return users.filter((u) =>
 u.name.toLowerCase().includes(mentionFilter) || u.email.toLowerCase().includes(mentionFilter)
 ).slice(0, 5);
 }

 function renderContent(content: string): string {
 return content.replace(/@(\w+)/g, '<span class="badge badge-primary badge-xs">@$1</span>');
 }
</script>

<div class="space-y-3">
 <h3 class="font-bold text-sm flex items-center gap-2 opacity-70">💬 Comments ({comments.length})</h3>

 {#if error}
 <div class="alert alert-error text-xs">⚠️ {error}</div>
 {/if}

 {#if loading}
 <div class="flex justify-center py-4"><span class="loading loading-spinner loading-sm"></span></div>
 {:else}
 <div class="space-y-2 max-h-64 overflow-y-auto">
 {#each comments as comment}
 <div class="flex gap-2 group">
 <div class="avatar placeholder shrink-0">
 <div class="w-7 h-7 rounded-full bg-neutral text-neutral-content text-xs">{getInitials(comment)}</div>
 </div>
 <div class="flex-1 min-w-0">
 <div class="flex items-baseline gap-2">
 <span class="text-xs font-bold">{comment.user_name || comment.user_email || 'User'}</span>
 <span class="text-[10px] opacity-40">{formatDate(comment.created_at)}</span>
 </div>
 <p class="text-sm mt-0.5">{@html renderContent(comment.content)}</p>
 </div>
 {#if comment.user_id === currentUserId}
 <button
 class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100 text-error shrink-0"
 onclick={() => deleteComment(comment.id)}
 ><Trash2 size={12} /></button>
 {/if}
 </div>
 {/each}
 {#if comments.length === 0}
 <p class="text-sm opacity-40 text-center py-2">No comments yet</p>
 {/if}
 </div>

 <div class="relative">
 <div class="flex gap-2">
 <div class="flex-1 relative">
 <textarea
 class="textarea textarea-sm w-full pr-8 resize-none"
 rows="2"
 bind:value={newComment}
 oninput={handleInput}
 placeholder="Add a comment... Use @ to mention users"
 onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComment(); } }}
 ></textarea>
 <div class="absolute right-2 top-2 opacity-40"><AtSign size={14} /></div>
 </div>
 <button class="btn btn-primary btn-sm self-end" onclick={sendComment} disabled={sending || !newComment.trim()}>
 {#if sending}<span class="loading loading-spinner loading-sm"></span>{:else}<Send size={14} />{/if}
 </button>
 </div>

 {#if showMentions && users.length > 0}
 <div class="absolute bottom-full mb-1 left-0 w-full bg-base-100 border border-base-300 rounded-lg shadow-lg z-10 max-h-32 overflow-y-auto">
 {#each getFilteredUsers() as user}
 <button class="w-full px-3 py-2 text-left hover:bg-base-200 text-sm flex items-center gap-2" onclick={() => insertMention(user)}>
 <div class="avatar placeholder">
 <div class="w-6 h-6 rounded-full bg-neutral text-neutral-content text-xs">{user.name.substring(0, 2).toUpperCase()}</div>
 </div>
 <div>
 <div class="font-medium">{user.name}</div>
 <div class="text-xs opacity-50">{user.email}</div>
 </div>
 </button>
 {/each}
 </div>
 {/if}
 </div>
 {/if}
</div>
