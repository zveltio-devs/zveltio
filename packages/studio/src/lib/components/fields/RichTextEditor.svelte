<script lang="ts">
 import { onMount, onDestroy } from 'svelte';
 import { Editor } from '@tiptap/core';
 import StarterKit from '@tiptap/starter-kit';
 import Link from '@tiptap/extension-link';
 import Image from '@tiptap/extension-image';
 import { Table } from '@tiptap/extension-table';
 import { TableRow } from '@tiptap/extension-table-row';
 import { TableCell } from '@tiptap/extension-table-cell';
 import { TableHeader } from '@tiptap/extension-table-header';
import { Bold, Italic, Strikethrough, Code, List, ListOrdered, TextQuote as Quote, Undo2 as Undo, Redo2 as Redo, Link as LinkIcon, Image as ImageIcon, Table as TableIcon, Heading1, Heading2, Heading3 } from '@lucide/svelte';

 interface Props {
 value?: string;
 placeholder?: string;
 readonly?: boolean;
 }

 let {
 value = $bindable(''),
 placeholder = 'Start typing...',
 readonly = false,
 }: Props = $props();

 let editorElement: HTMLDivElement;
 let editor: Editor | null = null;

 onMount(() => {
 editor = new Editor({
 element: editorElement,
 extensions: [
 StarterKit,
 Link.configure({ openOnClick: false }),
 Image,
 Table.configure({ resizable: true }),
 TableRow,
 TableCell,
 TableHeader,
 ],
 content: value || '',
 editable: !readonly,
 onUpdate: ({ editor }) => {
 value = editor.getHTML();
 },
 });
 });

 onDestroy(() => {
 editor?.destroy();
 });

 function toggleBold() { editor?.chain().focus().toggleBold().run(); }
 function toggleItalic() { editor?.chain().focus().toggleItalic().run(); }
 function toggleStrike() { editor?.chain().focus().toggleStrike().run(); }
 function toggleCode() { editor?.chain().focus().toggleCode().run(); }
 function toggleBulletList() { editor?.chain().focus().toggleBulletList().run(); }
 function toggleOrderedList() { editor?.chain().focus().toggleOrderedList().run(); }
 function toggleBlockquote() { editor?.chain().focus().toggleBlockquote().run(); }
 function setHeading(level: 1 | 2 | 3) { editor?.chain().focus().toggleHeading({ level }).run(); }
 function undo() { editor?.chain().focus().undo().run(); }
 function redo() { editor?.chain().focus().redo().run(); }

 function addLink() {
 const url = prompt('Enter URL:');
 if (url) editor?.chain().focus().setLink({ href: url }).run();
 }

 function addImage() {
 const url = prompt('Enter image URL:');
 if (url) editor?.chain().focus().setImage({ src: url }).run();
 }

 function insertTable() {
 editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
 }
</script>

<div class="richtext-editor border border-base-300 rounded-lg overflow-hidden">
 {#if !readonly}
 <div class="toolbar bg-base-200 border-b border-base-300 p-2 flex flex-wrap gap-1">
 <button type="button" class="btn btn-xs btn-ghost" onclick={undo} title="Undo"><Undo size={14} /></button>
 <button type="button" class="btn btn-xs btn-ghost" onclick={redo} title="Redo"><Redo size={14} /></button>
 <div class="divider divider-horizontal mx-0"></div>
 <button type="button" class="btn btn-xs btn-ghost" onclick={() => setHeading(1)} title="H1"><Heading1 size={14} /></button>
 <button type="button" class="btn btn-xs btn-ghost" onclick={() => setHeading(2)} title="H2"><Heading2 size={14} /></button>
 <button type="button" class="btn btn-xs btn-ghost" onclick={() => setHeading(3)} title="H3"><Heading3 size={14} /></button>
 <div class="divider divider-horizontal mx-0"></div>
 <button type="button" class="btn btn-xs btn-ghost" onclick={toggleBold} title="Bold"><Bold size={14} /></button>
 <button type="button" class="btn btn-xs btn-ghost" onclick={toggleItalic} title="Italic"><Italic size={14} /></button>
 <button type="button" class="btn btn-xs btn-ghost" onclick={toggleStrike} title="Strike"><Strikethrough size={14} /></button>
 <button type="button" class="btn btn-xs btn-ghost" onclick={toggleCode} title="Code"><Code size={14} /></button>
 <div class="divider divider-horizontal mx-0"></div>
 <button type="button" class="btn btn-xs btn-ghost" onclick={toggleBulletList} title="Bullet List"><List size={14} /></button>
 <button type="button" class="btn btn-xs btn-ghost" onclick={toggleOrderedList} title="Ordered List"><ListOrdered size={14} /></button>
 <button type="button" class="btn btn-xs btn-ghost" onclick={toggleBlockquote} title="Quote"><Quote size={14} /></button>
 <div class="divider divider-horizontal mx-0"></div>
 <button type="button" class="btn btn-xs btn-ghost" onclick={addLink} title="Link"><LinkIcon size={14} /></button>
 <button type="button" class="btn btn-xs btn-ghost" onclick={addImage} title="Image"><ImageIcon size={14} /></button>
 <button type="button" class="btn btn-xs btn-ghost" onclick={insertTable} title="Table"><TableIcon size={14} /></button>
 </div>
 {/if}
 <div bind:this={editorElement} class="prose prose-sm max-w-none p-4 min-h-50 focus:outline-none"></div>
</div>

<style>
 :global(.ProseMirror) { outline: none !important; }
 :global(.ProseMirror h1) { font-size: 1.5rem; font-weight: bold; margin-top: 1rem; margin-bottom: 0.5rem; }
 :global(.ProseMirror h2) { font-size: 1.25rem; font-weight: bold; margin-top: 0.75rem; margin-bottom: 0.5rem; }
 :global(.ProseMirror h3) { font-size: 1.125rem; font-weight: bold; margin-top: 0.5rem; margin-bottom: 0.25rem; }
 :global(.ProseMirror p) { margin-top: 0.5rem; margin-bottom: 0.5rem; }
 :global(.ProseMirror ul), :global(.ProseMirror ol) { margin-top: 0.5rem; margin-bottom: 0.5rem; margin-left: 1.5rem; }
 :global(.ProseMirror blockquote) { border-left: 4px solid hsl(var(--bc) / 0.2); padding-left: 1rem; font-style: italic; margin-top: 0.5rem; margin-bottom: 0.5rem; }
 :global(.ProseMirror code) { background-color: hsl(var(--b2)); padding: 0.125rem 0.25rem; border-radius: 0.25rem; font-family: monospace; font-size: 0.875rem; }
 :global(.ProseMirror img) { max-width: 100%; height: auto; border-radius: 0.5rem; }
 :global(.ProseMirror table) { border-collapse: collapse; width: 100%; margin-top: 0.5rem; margin-bottom: 0.5rem; }
 :global(.ProseMirror th), :global(.ProseMirror td) { border: 1px solid hsl(var(--bc) / 0.2); padding: 0.5rem 0.75rem; }
 :global(.ProseMirror th) { background-color: hsl(var(--b2)); font-weight: bold; }
</style>
