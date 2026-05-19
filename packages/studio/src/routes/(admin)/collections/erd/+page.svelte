<script lang="ts">
  /**
   * Schema visualiser (ERD) — diagram of every collection and its relations.
   * Pan, zoom, drag-to-rearrange. Layouts persist in localStorage so the
   * arrangement survives reload but is intentionally per-browser — different
   * people on the same project can each have their own mental map.
   *
   * Layout: auto grid (sorted by name) + per-card user overrides. Edges:
   * SVG cubic Beziers from source-right to target-left.
   *
   * Why HTML cards + SVG edges (not full SVG): native text rendering is
   * much sharper, Tailwind/DaisyUI classes work, and we keep keyboard +
   * accessibility for free. The cost is two coordinate systems — but
   * a single `transform: scale()` on the wrapping <div> keeps them aligned.
   *
   * Why localStorage and not a server-side `zv_erd_layout` table:
   * server-side would force a migration + per-tenant row + sync conflicts.
   * Layouts are a per-user preference, not a shared schema artefact. If
   * teams want shared layouts later, we promote the storage layer behind
   * the same `userPositions` interface.
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { collectionsApi, api } from '$lib/api.js';
  import {
    ArrowLeft, ZoomIn, ZoomOut, Maximize2, Eye, EyeOff, Database, RefreshCw,
    RotateCcw, Download, Image as ImageIcon, GitFork, Trash2, Plus, Pencil,
  } from '@lucide/svelte';
  import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  interface FieldDef { name: string; type: string; required?: boolean; options?: any }
  interface Collection { name: string; display_name?: string; is_system?: boolean; fields: FieldDef[] }
  interface Relation { source_collection: string; target_collection: string; type: string; source_field?: string }

  const STORAGE_KEY = 'zveltio.erd.positions.v1';

  let collections = $state<Collection[]>([]);
  let relations   = $state<Relation[]>([]);
  let loading     = $state(true);
  let showSystem  = $state(false);
  let zoom        = $state(1);
  let panX        = $state(0);
  let panY        = $state(0);

  /** Per-collection user-dragged positions. Keys are collection names. */
  let userPositions = $state<Record<string, { x: number; y: number }>>({});

  const NODE_W = 240;
  const NODE_ROW_H = 22;
  const NODE_HEAD_H = 44;
  const NODE_PAD = 8;
  const GRID_GAP_X = 80;
  const GRID_GAP_Y = 60;

  /** Visible collections after the system-filter toggle. */
  const visible = $derived.by(() => {
    const list = (collections ?? [])
      .map((c) => ({
        ...c,
        fields: parseFields(c.fields),
      }))
      .filter((c) => showSystem || !c.is_system);
    // Stable order: system collections last, others alphabetical.
    return list.sort((a, b) => {
      const sa = a.is_system ? 1 : 0;
      const sb = b.is_system ? 1 : 0;
      if (sa !== sb) return sa - sb;
      return a.name.localeCompare(b.name);
    });
  });

  /**
   * Positions for each visible collection.
   * Strategy: auto-grid as the baseline, then `userPositions` override any
   * card the user has manually dragged. Reading `userPositions` makes this
   * reactive — dragging a card re-runs the derivation and the SVG edges
   * automatically follow.
   */
  const layout = $derived.by(() => {
    const result = new Map<string, { x: number; y: number; height: number }>();
    if (visible.length === 0) return result;
    const cols = Math.max(1, Math.ceil(Math.sqrt(visible.length * 1.6)));
    visible.forEach((c, i) => {
      const h = cardHeight(c);
      // Auto-grid baseline:
      const row = Math.floor(i / cols);
      const col = i % cols;
      const autoX = col * (NODE_W + GRID_GAP_X) + 40;
      const rowsAbove = Array.from({ length: row }, (_, r) => {
        const rowItems = visible.slice(r * cols, (r + 1) * cols);
        return Math.max(...rowItems.map((it) => cardHeight(it)));
      });
      const autoY = rowsAbove.reduce((acc, hh) => acc + hh + GRID_GAP_Y, 40);

      // User override wins.
      const override = userPositions[c.name];
      result.set(c.name, {
        x: override?.x ?? autoX,
        y: override?.y ?? autoY,
        height: h,
      });
    });
    return result;
  });

  /** Edges drawn between cards — one per relation pair. */
  const edges = $derived.by(() => {
    return (relations ?? [])
      .filter((r) => layout.has(r.source_collection) && layout.has(r.target_collection))
      .map((r) => {
        const src = layout.get(r.source_collection)!;
        const dst = layout.get(r.target_collection)!;
        const x1 = src.x + NODE_W;
        const y1 = src.y + NODE_HEAD_H + src.height / 2;
        const x2 = dst.x;
        const y2 = dst.y + NODE_HEAD_H + dst.height / 2;
        const dx = Math.max(40, Math.abs(x2 - x1) / 2);
        const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        return { d, type: r.type, from: r.source_collection, to: r.target_collection };
      });
  });

  /** Bounding box for the viewport "Fit to view" action. */
  const bounds = $derived.by(() => {
    if (visible.length === 0) return { w: 800, h: 600 };
    let maxX = 0, maxY = 0;
    for (const c of visible) {
      const pos = layout.get(c.name);
      if (!pos) continue;
      maxX = Math.max(maxX, pos.x + NODE_W);
      maxY = Math.max(maxY, pos.y + NODE_HEAD_H + pos.height);
    }
    return { w: maxX + 80, h: maxY + 80 };
  });

  function cardHeight(c: { fields?: FieldDef[] }): number {
    const n = Math.min(c.fields?.length ?? 0, 12); // cap visible rows
    return n * NODE_ROW_H + NODE_PAD * 2;
  }

  function parseFields(f: any): FieldDef[] {
    if (!f) return [];
    try {
      return typeof f === 'string' ? JSON.parse(f) : f;
    } catch {
      return [];
    }
  }

  async function load() {
    loading = true;
    try {
      const [colRes, relRes] = await Promise.all([
        collectionsApi.list(),
        api.get<{ relations: Relation[] }>('/api/relations'),
      ]);
      collections = colRes.collections ?? [];
      relations = relRes.relations ?? [];
    } finally {
      loading = false;
    }
  }

  function fitToView() {
    const container = document.getElementById('erd-viewport');
    if (!container) return;
    const padding = 40;
    const cw = container.clientWidth - padding * 2;
    const ch = container.clientHeight - padding * 2;
    const zx = cw / bounds.w;
    const zy = ch / bounds.h;
    zoom = Math.min(1, Math.max(0.2, Math.min(zx, zy)));
    panX = padding;
    panY = padding;
  }

  // ── Pan + zoom interactions ──────────────────────────────────────────────
  // Three drag modes coexist:
  //   - canvas pan       (drag empty space)
  //   - card move        (drag a card → reposition + persist)
  //   - click navigation (mousedown + release without movement → open card)
  // We disambiguate by tracking the click target + total movement.

  type DragMode = 'idle' | 'pan' | 'card';
  // These three drive template bindings (cursor classes, "didMove" border
  // highlight). Plain `let` would leave the DOM stale after assignment, so
  // they must be $state. The pure numeric trackers (dragStartX/Y,
  // panStartX/Y, cardStartX/Y) are read by mousemove handlers but never
  // rendered, so they stay as plain locals.
  let dragMode = $state<DragMode>('idle');
  let cardDragName = $state('');
  let didMove = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;
  let cardStartX = 0;
  let cardStartY = 0;
  const CLICK_THRESHOLD_PX = 4;

  function onCanvasMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-card]')) return; // card has its own mousedown
    dragMode = 'pan';
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    didMove = false;
  }

  function onCardMouseDown(e: MouseEvent, name: string) {
    if (e.button !== 0) return;
    // Don't intercept clicks on interactive child elements (buttons, links).
    const target = e.target as HTMLElement;
    if (target.closest('button, [data-no-drag]')) return;
    e.stopPropagation();
    e.preventDefault();
    const pos = layout.get(name);
    if (!pos) return;
    dragMode = 'card';
    cardDragName = name;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    cardStartX = pos.x;
    cardStartY = pos.y;
    didMove = false;
  }

  function onMouseMove(e: MouseEvent) {
    if (dragMode === 'idle') return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) + Math.abs(dy) > CLICK_THRESHOLD_PX) didMove = true;

    if (dragMode === 'pan') {
      panX = panStartX + dx;
      panY = panStartY + dy;
    } else if (dragMode === 'card') {
      // Cards live in the scaled world. The viewport mouse-delta is in
      // screen pixels, so divide by zoom to translate back to world units.
      const wx = cardStartX + dx / zoom;
      const wy = cardStartY + dy / zoom;
      userPositions = { ...userPositions, [cardDragName]: { x: wx, y: wy } };
    }
  }

  function onMouseUp(e: MouseEvent) {
    if (dragMode === 'card') {
      if (!didMove) {
        // Treat as click → navigate
        goto(`${base}/collections/${cardDragName}`);
      } else {
        persistPositions();
      }
    }
    dragMode = 'idle';
    cardDragName = '';
  }

  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return; // require modifier to zoom — otherwise scroll the page
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    zoom = Math.max(0.2, Math.min(2.5, zoom + delta));
  }

  // ── Position persistence ─────────────────────────────────────────────────
  // Strategy: server-side is the source of truth (synced across browsers,
  // tied to the user), localStorage is a fast offline-first fallback.
  //
  // On mount we fetch the server layout and merge in any localStorage that
  // doesn't have a server counterpart (legacy installs / offline edits).
  // On drag-end we debounce a PUT to the server + always update localStorage
  // so a quick reload picks up the fresh state immediately without waiting
  // for the network round-trip.
  let serverSynced = $state(false);
  let serverPersistTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadPositions(): Promise<void> {
    // Always seed from localStorage first — instant, no network.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) userPositions = JSON.parse(raw);
    } catch { /* storage disabled / quota — ignore */ }

    // Then fetch the authoritative copy from the engine. If it succeeds,
    // it replaces local state. If it fails, localStorage stays.
    try {
      const res = await api.get<{ positions: Record<string, { x: number; y: number }> }>('/api/erd/layout');
      const remote = res.positions ?? {};
      // Merge: server wins for collections it knows about, localStorage
      // keeps anything not yet synced (e.g. user dragged offline).
      const merged: Record<string, { x: number; y: number }> = { ...userPositions, ...remote };
      userPositions = merged;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)); } catch { /* ignore */ }
      serverSynced = true;
    } catch { /* offline or pre-migration engine — stay on local */ }
  }

  function persistPositions(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(userPositions)); }
    catch { /* ignore */ }
    // Debounced PUT — coalesces rapid-fire drags into one round-trip.
    if (serverPersistTimer) clearTimeout(serverPersistTimer);
    serverPersistTimer = setTimeout(async () => {
      try {
        await api.put('/api/erd/layout', { positions: userPositions });
        serverSynced = true;
      } catch {
        serverSynced = false;
        /* keep localStorage as the offline fallback */
      }
    }, 600);
  }

  async function resetLayout() {
    userPositions = {};
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    try { await api.delete('/api/erd/layout'); } catch { /* ignore offline */ }
    requestAnimationFrame(() => fitToView());
    toast.success('Layout reset to auto-grid.');
  }

  // ── Force-directed layout (Fruchterman–Reingold, simplified) ────────────
  // Runs a few hundred iterations, then writes results into userPositions so
  // the existing render path picks them up. Not animated — settles instantly.
  async function applyForceLayout() {
    if (visible.length === 0) return;
    const nodes = visible.map((c) => ({
      name: c.name,
      x: layout.get(c.name)?.x ?? 0,
      y: layout.get(c.name)?.y ?? 0,
      vx: 0, vy: 0,
      h: cardHeight(c),
    }));
    const idx = new Map(nodes.map((n, i) => [n.name, i]));
    const links = relations
      .map((r) => ({ s: idx.get(r.source_collection), t: idx.get(r.target_collection) }))
      .filter((l): l is { s: number; t: number } => l.s !== undefined && l.t !== undefined);

    const area = Math.max(1, bounds.w * bounds.h);
    const k = Math.sqrt(area / nodes.length);
    let temp = bounds.w / 10;
    const cooling = 0.95;
    const iters = 200;

    for (let it = 0; it < iters; it++) {
      // Repulsion
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        a.vx = 0; a.vy = 0;
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const repel = (k * k) / dist;
          a.vx += (dx / dist) * repel;
          a.vy += (dy / dist) * repel;
        }
      }
      // Attraction along edges
      for (const l of links) {
        const a = nodes[l.s];
        const b = nodes[l.t];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const attract = (dist * dist) / k;
        const fx = (dx / dist) * attract;
        const fy = (dy / dist) * attract;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
      // Apply with temperature clamp
      for (const n of nodes) {
        const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        const limited = Math.min(speed, temp);
        if (speed > 0) {
          n.x += (n.vx / speed) * limited;
          n.y += (n.vy / speed) * limited;
        }
        n.x = Math.max(40, n.x);
        n.y = Math.max(40, n.y);
      }
      temp *= cooling;
    }

    const next: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) next[n.name] = { x: Math.round(n.x), y: Math.round(n.y) };
    userPositions = next;
    persistPositions();
    await tick();
    requestAnimationFrame(() => fitToView());
    toast.success('Applied force-directed layout.');
  }

  // ── Export (SVG + PNG) ──────────────────────────────────────────────────
  /**
   * Build a self-contained <svg> string that captures all cards + edges with
   * inline styles. We avoid <foreignObject> + HTML because rasterising that
   * via canvas is fragile across browsers — instead we re-emit the cards as
   * plain SVG <rect>+<text> using the same coordinates the renderer uses.
   */
  function buildExportSvg(): string {
    const W = bounds.w;
    const H = bounds.h;
    const lines: string[] = [];
    lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
    lines.push('<style>.t{font:600 12px Inter,sans-serif;fill:#0f172a}.tn{font:11px monospace;fill:#475569}.tf{font:11px monospace;fill:#1e293b}.tr{font:11px monospace;fill:#4f46e5}.ty{font:10px monospace;fill:#94a3b8}</style>');
    lines.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

    // Edges first
    for (const e of edges) {
      lines.push(`<path d="${e.d}" stroke="${edgeColor(e.type)}" stroke-width="1.5" fill="none" opacity="0.7"/>`);
    }

    // Cards
    for (const c of visible) {
      const pos = layout.get(c.name);
      if (!pos) continue;
      const headerH = NODE_HEAD_H;
      const totalH = headerH + pos.height;
      lines.push(`<g transform="translate(${pos.x},${pos.y})">`);
      lines.push(`<rect width="${NODE_W}" height="${totalH}" rx="8" ry="8" fill="#ffffff" stroke="#cbd5e1" stroke-width="2"/>`);
      lines.push(`<rect width="${NODE_W}" height="${headerH}" rx="8" ry="8" fill="#f1f5f9"/>`);
      lines.push(`<rect y="${headerH - 1}" width="${NODE_W}" height="2" fill="#cbd5e1"/>`);
      lines.push(`<text class="t" x="12" y="20">${escape(c.display_name || c.name)}</text>`);
      lines.push(`<text class="tn" x="12" y="34">${escape(c.name)}</text>`);
      const shown = c.fields.slice(0, 12);
      shown.forEach((f, i) => {
        const y = headerH + NODE_PAD + i * NODE_ROW_H + 12;
        const isRel = ['m2o', 'o2m', 'm2m', 'reference'].includes(f.type);
        lines.push(`<text class="${isRel ? 'tr' : 'tf'}" x="12" y="${y}">${escape(f.name)}</text>`);
        lines.push(`<text class="ty" x="${NODE_W - 12}" y="${y}" text-anchor="end">${escape(f.type)}</text>`);
      });
      if (c.fields.length > 12) {
        const y = headerH + NODE_PAD + shown.length * NODE_ROW_H + 12;
        lines.push(`<text class="ty" x="12" y="${y}">+ ${c.fields.length - 12} more</text>`);
      }
      lines.push('</g>');
    }
    lines.push('</svg>');
    return lines.join('');
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportSvg() {
    const svg = buildExportSvg();
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `zveltio-schema-${stamp()}.svg`);
    toast.success('Downloaded SVG.');
  }

  async function exportPng() {
    const svg = buildExportSvg();
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load SVG image'));
        img.src = url;
      });
      const scale = 2; // export at @2x for crispness
      const canvas = document.createElement('canvas');
      canvas.width = bounds.w * scale;
      canvas.height = bounds.h * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) {
          toast.error('Failed to encode PNG');
          return;
        }
        downloadBlob(blob, `zveltio-schema-${stamp()}.png`);
        toast.success('Downloaded PNG (@2×).');
      }, 'image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function escape(s: string): string {
    return s.replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[ch] || ch));
  }
  function stamp(): string {
    return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  }

  // ── New / delete collection from canvas ─────────────────────────────────
  let newCollectionOpen = $state(false);
  let newCollectionName = $state('');
  let newCollectionError = $state('');
  let saving = $state(false);

  function validateName(n: string): string {
    if (!n) return 'Name is required';
    if (n.length > 60) return 'Max 60 characters';
    if (!/^[a-z][a-z0-9_]*$/.test(n)) return 'Lowercase letters, digits, underscore; must start with a letter';
    if (collections.some((c) => c.name === n)) return 'Collection already exists';
    return '';
  }

  async function createCollection() {
    newCollectionError = validateName(newCollectionName);
    if (newCollectionError) return;
    saving = true;
    try {
      // Create with a single optional `title` field. The user can refine the
      // schema later — the point of this entry point is "add a node now,
      // edit it after".
      await collectionsApi.create({
        name: newCollectionName,
        fields: [{ name: 'title', type: 'text', required: false }],
      });
      toast.success(`Collection '${newCollectionName}' is being created.`);
      newCollectionOpen = false;
      newCollectionName = '';
      // Poll briefly so the new collection shows up without a manual reload.
      setTimeout(load, 800);
    } catch (err: any) {
      newCollectionError = err?.message ?? 'Failed to create';
    } finally {
      saving = false;
    }
  }

  async function deleteCollection(name: string) {
    if (!confirm(`Drop collection "${name}"? This is irreversible.`)) return;
    try {
      await collectionsApi.delete(name);
      toast.success(`Collection '${name}' deleted.`);
      delete userPositions[name];
      userPositions = { ...userPositions };
      persistPositions();
      await load();
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to delete collection');
    }
  }

  // ── Inline field operations ─────────────────────────────────────────────
  // Each card can expand to show an "add field" mini-form, or hover to expose
  // a trash icon next to each non-system field.

  let addFieldOpenFor = $state('');
  let newFieldName = $state('');
  let newFieldType = $state('text');
  let newFieldRequired = $state(false);
  let newFieldError = $state('');

  const FIELD_TYPES_QUICK = [
    'text', 'number', 'boolean', 'date', 'datetime',
    'email', 'url', 'json', 'richtext',
  ];

  function openAddField(name: string) {
    addFieldOpenFor = name;
    newFieldName = '';
    newFieldType = 'text';
    newFieldRequired = false;
    newFieldError = '';
  }
  function closeAddField() { addFieldOpenFor = ''; newFieldError = ''; }

  async function submitAddField(collectionName: string) {
    if (!newFieldName) { newFieldError = 'Field name required'; return; }
    if (!/^[a-z][a-z0-9_]*$/.test(newFieldName)) {
      newFieldError = 'Lowercase letters, digits, underscore; must start with a letter';
      return;
    }
    try {
      await api.post(`/api/collections/${collectionName}/fields`, {
        name: newFieldName,
        type: newFieldType,
        required: newFieldRequired,
      });
      toast.success(`Added '${newFieldName}' to ${collectionName}.`);
      closeAddField();
      await load();
    } catch (err: any) {
      newFieldError = err?.message ?? 'Failed to add field';
    }
  }

  async function deleteField(collectionName: string, fieldName: string) {
    if (!confirm(`Remove field "${fieldName}" from ${collectionName}? Existing data in this column will be lost.`)) return;
    try {
      await api.delete(`/api/collections/${collectionName}/fields/${fieldName}`);
      toast.success(`Removed '${fieldName}'.`);
      await load();
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to remove field');
    }
  }

  // Inline rename — double-click a field name to edit. Works on every
  // field type (relations included) since the engine now supports
  // renaming source-side relation fields atomically.
  let renamingKey  = $state('');
  let renameValue  = $state('');
  let renameError  = $state('');

  function startRename(collectionName: string, fieldName: string) {
    renamingKey = `${collectionName}.${fieldName}`;
    renameValue = fieldName;
    renameError = '';
  }
  function cancelRename() {
    renamingKey = '';
    renameValue = '';
    renameError = '';
  }
  async function commitRename(collectionName: string, oldName: string) {
    const next = renameValue.trim();
    if (next === oldName || !next) { cancelRename(); return; }
    if (!/^[a-z][a-z0-9_]*$/.test(next)) {
      renameError = 'Lowercase letters, digits, underscore; must start with a letter';
      return;
    }
    try {
      await api.patch(`/api/collections/${collectionName}/fields/${oldName}`, { new_name: next });
      toast.success(`Renamed '${oldName}' → '${next}'.`);
      cancelRename();
      await load();
    } catch (err: any) {
      renameError = err?.message ?? 'Rename failed';
    }
  }

  // Field-edit popover — pencil icon on each non-system field opens this.
  // Supports renaming + changing type + toggling required in one save.
  let editingKey      = $state('');
  let editFieldName   = $state('');
  let editFieldType   = $state('text');
  let editRequired    = $state(false);
  let editOriginalType = $state('');
  let editError       = $state('');
  let editSaving      = $state(false);

  function openFieldEdit(collectionName: string, field: FieldDef) {
    editingKey = `${collectionName}.${field.name}`;
    editFieldName = field.name;
    editFieldType = field.type;
    editOriginalType = field.type;
    editRequired = !!field.required;
    editError = '';
  }
  function closeFieldEdit() {
    editingKey = '';
    editError = '';
  }

  async function commitFieldEdit(collectionName: string, originalName: string) {
    editError = '';
    if (!/^[a-z][a-z0-9_]*$/.test(editFieldName)) {
      editError = 'Lowercase letters, digits, underscore; must start with a letter';
      return;
    }
    const body: Record<string, any> = {};
    if (editFieldName !== originalName) body.new_name = editFieldName;
    if (editFieldType !== editOriginalType) body.new_type = editFieldType;
    // Always send required so the engine can apply the toggle if needed
    // (it short-circuits if the new value matches the current one).
    body.required = editRequired;
    if (Object.keys(body).length === 0) { closeFieldEdit(); return; }

    editSaving = true;
    try {
      const res = await api.patch<{ actions: string[] }>(
        `/api/collections/${collectionName}/fields/${originalName}`,
        body,
      );
      toast.success(`Updated: ${res.actions?.join(', ') ?? 'field updated'}`);
      closeFieldEdit();
      await load();
    } catch (err: any) {
      editError = err?.message ?? 'Update failed';
    } finally {
      editSaving = false;
    }
  }

  function isSystemField(name: string): boolean {
    return ['id', 'created_at', 'updated_at', 'status', 'created_by', 'updated_by', 'search_vector', 'search_text'].includes(name);
  }

  onMount(async () => {
    // Layout fetch in parallel with the schema fetch — the user sees
    // collections appear instantly and their stored positions snap in
    // shortly after, instead of blocking the whole paint.
    void loadPositions();
    await load();
    requestAnimationFrame(() => fitToView());
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });
  onDestroy(() => {
    // Flush any pending position PUT so navigating away doesn't drop the
    // last drag. Sending synchronously isn't possible from beforeunload in
    // modern browsers (fetch is async); the best we can do is fire-and-
    // forget — the server will still receive it if the page survives long
    // enough, otherwise localStorage carries us through.
    if (serverPersistTimer) {
      clearTimeout(serverPersistTimer);
      void api.put('/api/erd/layout', { positions: userPositions }).catch(() => {});
    }
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  });

  function edgeColor(type: string): string {
    switch (type) {
      case 'm2o': case 'reference': return '#6366f1'; // indigo — N→1
      case 'o2m': return '#22c55e';                   // green  — 1→N
      case 'm2m': return '#f59e0b';                   // amber  — N↔N
      default:    return '#94a3b8';
    }
  }
</script>

<div class="flex flex-col h-[calc(100vh-4rem)]">

  <!-- Toolbar -->
  <div class="flex items-center gap-2 p-3 border-b border-base-300 bg-base-100 flex-wrap">
    <a href="{base}/collections" class="btn btn-ghost btn-sm gap-1" aria-label="Back to collections list">
      <ArrowLeft size={14} /> Collections
    </a>
    <h1 class="text-base font-semibold ml-2 flex items-center gap-2">
      <Database size={16} /> Schema diagram
    </h1>
    <span class="text-xs text-base-content/50">
      {visible.length} {visible.length === 1 ? 'collection' : 'collections'} · {edges.length} {edges.length === 1 ? 'relation' : 'relations'}
    </span>

    <div class="grow"></div>

    <button class="btn btn-primary btn-sm gap-1" onclick={() => (newCollectionOpen = true)} aria-label="New collection">
      <Database size={14} /> New collection
    </button>

    <div class="divider divider-horizontal mx-0"></div>

    <label class="flex items-center gap-1.5 text-xs cursor-pointer" title="Toggle system collections (zv_*)">
      <input type="checkbox" class="toggle toggle-xs" bind:checked={showSystem} />
      {#if showSystem}<EyeOff size={13} />{:else}<Eye size={13} />{/if}
      System tables
    </label>

    <button class="btn btn-ghost btn-sm gap-1" onclick={applyForceLayout} title="Auto-arrange using force-directed layout">
      <GitFork size={13} /> Auto-arrange
    </button>
    <button class="btn btn-ghost btn-sm gap-1" onclick={resetLayout} title="Reset to default grid layout">
      <RotateCcw size={13} /> Reset
    </button>

    <span
      class="text-[10px] tabular-nums {serverSynced ? 'text-success' : 'text-base-content/40'}"
      title={serverSynced ? 'Layout synced to your account' : 'Layout saved locally only — sign in to sync across devices'}
    >
      {serverSynced ? '● synced' : '○ local'}
    </span>

    <div class="divider divider-horizontal mx-0"></div>

    <button class="btn btn-ghost btn-sm" onclick={() => (zoom = Math.max(0.2, zoom - 0.1))} aria-label="Zoom out"><ZoomOut size={14} /></button>
    <span class="text-xs tabular-nums w-12 text-center">{Math.round(zoom * 100)}%</span>
    <button class="btn btn-ghost btn-sm" onclick={() => (zoom = Math.min(2.5, zoom + 0.1))} aria-label="Zoom in"><ZoomIn size={14} /></button>
    <button class="btn btn-ghost btn-sm gap-1" onclick={fitToView} aria-label="Fit to view"><Maximize2 size={14} /> Fit</button>

    <div class="divider divider-horizontal mx-0"></div>

    <div class="join">
      <button class="btn btn-ghost btn-sm gap-1 join-item" onclick={exportSvg} title="Download as SVG">
        <Download size={13} /> SVG
      </button>
      <button class="btn btn-ghost btn-sm gap-1 join-item" onclick={exportPng} title="Download as PNG @2×">
        <ImageIcon size={13} /> PNG
      </button>
    </div>

    <button class="btn btn-ghost btn-sm" onclick={load} aria-label="Reload schema" title="Reload"><RefreshCw size={14} /></button>
  </div>

  <!-- New-collection modal -->
  {#if newCollectionOpen}
    <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="new-col-title">
      <div class="bg-base-100 rounded-xl shadow-xl border border-base-300 p-6 w-full max-w-md">
        <h2 id="new-col-title" class="text-lg font-semibold mb-3">New collection</h2>
        <label class="block text-xs text-base-content/60 mb-1" for="new-col-name">Name (lowercase, snake_case)</label>
        <input
          id="new-col-name"
          class="input input-bordered input-sm w-full"
          bind:value={newCollectionName}
          oninput={() => (newCollectionError = '')}
          placeholder="invoices"
          autocomplete="off"
        />
        {#if newCollectionError}
          <p class="text-xs text-error mt-1">{newCollectionError}</p>
        {/if}
        <p class="text-xs text-base-content/50 mt-2">
          A single <code>title</code> text field is added by default. You can edit fields after creation.
        </p>
        <div class="flex justify-end gap-2 mt-5">
          <button class="btn btn-ghost btn-sm" onclick={() => { newCollectionOpen = false; newCollectionName = ''; newCollectionError = ''; }}>Cancel</button>
          <button class="btn btn-primary btn-sm" onclick={createCollection} disabled={saving}>
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Legend -->
  <div class="flex flex-wrap items-center gap-4 px-3 py-2 text-xs text-base-content/60 border-b border-base-300 bg-base-100">
    <span class="font-medium">Relation types:</span>
    <span class="flex items-center gap-1.5"><span class="inline-block w-4 h-0.5" style="background: #6366f1"></span> m2o / reference (N→1)</span>
    <span class="flex items-center gap-1.5"><span class="inline-block w-4 h-0.5" style="background: #22c55e"></span> o2m (1→N)</span>
    <span class="flex items-center gap-1.5"><span class="inline-block w-4 h-0.5" style="background: #f59e0b"></span> m2m (N↔N)</span>
    <span class="ml-auto opacity-70">Drag to pan · Ctrl/⌘+Wheel to zoom · Click a table to open · Double-click a field to rename</span>
  </div>

  <!-- Viewport -->
  <div
    id="erd-viewport"
    class="relative grow overflow-hidden bg-base-200 cursor-grab"
    class:cursor-grabbing={dragMode !== 'idle'}
    onmousedown={onCanvasMouseDown}
    onwheel={onWheel}
    role="application"
    aria-label="Schema diagram viewport"
  >
    {#if loading}
      <div class="absolute inset-0 flex items-center justify-center">
        <LoadingSkeleton />
      </div>
    {:else if visible.length === 0}
      <div class="absolute inset-0 flex flex-col items-center justify-center text-base-content/50 gap-2">
        <Database size={48} />
        <p class="text-sm">No collections yet.</p>
        <a href="{base}/collections" class="btn btn-primary btn-sm mt-2">Create your first collection</a>
      </div>
    {:else}
      <!-- World layer — translated + scaled together so HTML cards and SVG edges stay aligned. -->
      <div
        class="absolute top-0 left-0 origin-top-left"
        style="transform: translate({panX}px, {panY}px) scale({zoom}); width: {bounds.w}px; height: {bounds.h}px;"
      >
        <!-- Edges (under cards) -->
        <svg
          class="absolute top-0 left-0 pointer-events-none"
          width={bounds.w}
          height={bounds.h}
          viewBox="0 0 {bounds.w} {bounds.h}"
          aria-hidden="true"
        >
          {#each edges as e}
            <path d={e.d} stroke={edgeColor(e.type)} stroke-width="1.5" fill="none" opacity="0.7">
              <title>{e.from} → {e.to} ({e.type})</title>
            </path>
          {/each}
        </svg>

        <!-- Cards -->
        {#each visible as col (col.name)}
          {@const pos = layout.get(col.name)}
          {#if pos}
            <div
              data-card
              role="button"
              tabindex="0"
              class="absolute block rounded-lg shadow-md border-2 border-base-300 bg-base-100 hover:border-primary transition-colors overflow-hidden select-none group"
              class:cursor-grabbing={dragMode === 'card' && cardDragName === col.name}
              class:cursor-grab={!(dragMode === 'card' && cardDragName === col.name)}
              class:!border-primary={cardDragName === col.name && didMove}
              style="left: {pos.x}px; top: {pos.y}px; width: {NODE_W}px;"
              onmousedown={(e) => onCardMouseDown(e, col.name)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') goto(`${base}/collections/${col.name}`); }}
              title="Drag to move · click to open"
            >
              <!-- Header -->
              <div class="px-3 py-2 bg-base-200 border-b border-base-300 flex items-center gap-2">
                <Database size={14} class={col.is_system ? 'text-base-content/40' : 'text-primary'} />
                <div class="min-w-0 grow">
                  <div class="text-sm font-semibold truncate">{col.display_name || col.name}</div>
                  <div class="text-[10px] font-mono text-base-content/40 truncate">{col.name}</div>
                </div>
                {#if !col.is_system}
                  <button
                    data-no-drag
                    class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-1 h-auto min-h-0 text-error"
                    onclick={(e) => { e.stopPropagation(); deleteCollection(col.name); }}
                    title="Delete collection"
                    aria-label="Delete {col.name}"
                  >
                    <Trash2 size={12} />
                  </button>
                {/if}
              </div>

              <!-- Fields -->
              <div class="py-1">
                {#each col.fields.slice(0, 12) as field}
                  {@const isRel = ['m2o', 'o2m', 'm2m', 'reference'].includes(field.type)}
                  {@const isSys = isSystemField(field.name)}
                  {@const rowKey = `${col.name}.${field.name}`}
                  {@const renaming = renamingKey === rowKey}
                  {@const editingFull = editingKey === rowKey}
                  <div class="px-3 py-0.5 flex items-center gap-2 text-[11px] hover:bg-base-200 group/row">
                    {#if renaming}
                      <!-- Inline rename input. Submit on Enter, cancel on Escape, also save on blur. -->
                      <input
                        data-no-drag
                        class="input input-bordered input-xs grow text-[11px] font-mono h-6 px-1.5"
                        bind:value={renameValue}
                        onkeydown={(e) => {
                          if (e.key === 'Enter') commitRename(col.name, field.name);
                          else if (e.key === 'Escape') cancelRename();
                        }}
                        onblur={() => commitRename(col.name, field.name)}
                        onclick={(e) => e.stopPropagation()}
                        autocomplete="off"
                      />
                      <span class="text-base-content/40 shrink-0">{field.type}</span>
                      {#if renameError}
                        <span class="text-error text-[9px] absolute mt-5" title={renameError}>!</span>
                      {/if}
                    {:else}
                      <span
                        data-no-drag={!isSys && !col.is_system ? true : undefined}
                        class="font-mono truncate grow {isRel ? 'text-indigo-400' : ''} {isSys ? 'text-base-content/40' : ''}"
                        class:cursor-text={!isSys && !col.is_system}
                        ondblclick={(e) => {
                          if (isSys || col.is_system) return;
                          e.stopPropagation();
                          startRename(col.name, field.name);
                        }}
                        title={isSys ? 'system field' : 'double-click to rename · pencil to edit type/required'}
                      >{field.name}</span>
                      <span class="text-base-content/40 shrink-0">{field.type}</span>
                      {#if field.required}<span class="text-error">*</span>{/if}
                      {#if !isSys && !col.is_system}
                        <button
                          data-no-drag
                          class="opacity-0 group-hover/row:opacity-100 focus:opacity-100 transition-opacity text-base-content/40 hover:text-primary shrink-0"
                          onclick={(e) => { e.stopPropagation(); openFieldEdit(col.name, field); }}
                          title="Edit field (type, required)"
                          aria-label="Edit field {field.name}"
                        ><Pencil size={10} /></button>
                        <button
                          data-no-drag
                          class="opacity-0 group-hover/row:opacity-100 focus:opacity-100 transition-opacity text-base-content/40 hover:text-error shrink-0"
                          onclick={(e) => { e.stopPropagation(); deleteField(col.name, field.name); }}
                          title="Remove field"
                          aria-label="Remove field {field.name}"
                        >×</button>
                      {/if}
                    {/if}
                  </div>
                  {#if editingFull}
                    <div data-no-drag class="px-3 py-2 bg-base-200/70 border-y border-base-300 flex flex-col gap-1.5">
                      <div class="flex gap-1.5">
                        <input
                          class="input input-bordered input-xs grow text-[11px] font-mono"
                          bind:value={editFieldName}
                          placeholder="field name"
                          onkeydown={(e) => { if (e.key === 'Escape') closeFieldEdit(); }}
                          autocomplete="off"
                        />
                        <select
                          class="select select-bordered select-xs text-[11px]"
                          bind:value={editFieldType}
                          disabled={isRel}
                          title={isRel ? 'Type change not supported on relation fields' : ''}
                        >
                          {#each FIELD_TYPES_QUICK as t}<option value={t}>{t}</option>{/each}
                          {#if isRel}
                            <option value={editOriginalType}>{editOriginalType} (relation)</option>
                          {/if}
                        </select>
                      </div>
                      <label class="flex items-center gap-1.5 text-[10px] text-base-content/70 cursor-pointer">
                        <input type="checkbox" class="checkbox checkbox-xs" bind:checked={editRequired} />
                        required (NOT NULL)
                      </label>
                      {#if editError}
                        <p class="text-[10px] text-error">{editError}</p>
                      {/if}
                      <div class="flex gap-1 justify-end">
                        <button class="btn btn-ghost btn-xs" onclick={closeFieldEdit} disabled={editSaving}>Cancel</button>
                        <button class="btn btn-primary btn-xs" onclick={() => commitFieldEdit(col.name, field.name)} disabled={editSaving}>
                          {editSaving ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  {/if}
                {/each}
                {#if col.fields.length > 12}
                  <div class="px-3 py-1 text-[10px] text-base-content/40 italic">
                    + {col.fields.length - 12} more
                  </div>
                {/if}

                <!-- Add field affordance -->
                {#if !col.is_system}
                  {#if addFieldOpenFor === col.name}
                    <div data-no-drag class="px-3 py-2 border-t border-base-300 bg-base-200/50 flex flex-col gap-1.5">
                      <input
                        class="input input-bordered input-xs text-[11px]"
                        placeholder="field_name"
                        bind:value={newFieldName}
                        onkeydown={(e) => { if (e.key === 'Enter') submitAddField(col.name); if (e.key === 'Escape') closeAddField(); }}
                        autocomplete="off"
                      />
                      <div class="flex gap-1.5 items-center">
                        <select class="select select-bordered select-xs text-[11px] grow" bind:value={newFieldType}>
                          {#each FIELD_TYPES_QUICK as t}<option value={t}>{t}</option>{/each}
                        </select>
                        <label class="flex items-center gap-1 text-[10px] text-base-content/60 cursor-pointer">
                          <input type="checkbox" class="checkbox checkbox-xs" bind:checked={newFieldRequired} />
                          req
                        </label>
                      </div>
                      {#if newFieldError}
                        <p class="text-[10px] text-error">{newFieldError}</p>
                      {/if}
                      <div class="flex gap-1 justify-end">
                        <button class="btn btn-ghost btn-xs" onclick={closeAddField}>Cancel</button>
                        <button class="btn btn-primary btn-xs" onclick={() => submitAddField(col.name)}>Add</button>
                      </div>
                    </div>
                  {:else}
                    <button
                      data-no-drag
                      class="w-full text-left px-3 py-1 text-[10px] text-base-content/40 hover:text-primary hover:bg-base-200 transition-colors border-t border-base-300/50 flex items-center gap-1"
                      onclick={(e) => { e.stopPropagation(); openAddField(col.name); }}
                    >
                      <Plus size={10} /> add field
                    </button>
                  {/if}
                {/if}
              </div>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>
