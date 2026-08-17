<script lang="ts">
  /**
   * Pages — sites, their pages, and the block editor.
   *
   * One screen replaces two. Page-builder's editor listed pages with no notion
   * of which site they belonged to; portals' zone screen listed zones and, for
   * each, a list of saved views. Here a site is picked first and its pages are
   * edited with the same block editor whether the site is the public website or
   * an authenticated portal.
   *
   * The portals screen also called `/api/zones`, an engine route that stopped
   * existing when portals was extracted into an extension — so it answered 404
   * on every load. The paths below are the extension's own.
   */
  import { m } from '$lib/i18n.svelte.js';
  import { onMount, onDestroy } from 'svelte';
  import { api } from '$lib/api.js';
  import type { Block } from '$lib/ext/content/pages/lib/builder-types.js';
  import { BREAKPOINT_LABEL, type Breakpoint } from '$lib/ext/content/pages/lib/breakpoints.js';
  import {
    ensureIds, findById, insertAt, isContainer, patchById, removeById,
  } from '$lib/ext/content/pages/lib/block-tree.js';
  import BlockLibrary from '$lib/ext/content/pages/components/builder/BlockLibrary.svelte';
  import Canvas from '$lib/ext/content/pages/components/builder/Canvas.svelte';
  import PropertiesPanel from '$lib/ext/content/pages/components/builder/PropertiesPanel.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import {
    Plus, Trash2, Save, LoaderCircle, FileText, Menu as MenuIcon, X, ArrowLeft,
    Globe, Lock, Settings, Monitor, Tablet, Smartphone, RotateCcw, RotateCw, Check,
    CornerDownRight, History, Gauge, BookmarkPlus,
  } from '@lucide/svelte';

  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  const BASE = '/ext/content/pages';

  type Site = {
    id: string; name: string; slug: string; description: string | null;
    is_active: boolean; is_public: boolean; access_roles: string[];
    public_collections: string[]; base_path: string;
    site_name: string | null; site_logo_url: string | null;
    primary_color: string | null; nav_position: string; show_breadcrumbs: boolean;
  };
  type Page = {
    id: string; site_id: string | null; title: string; slug: string; blocks: Block[];
    meta_title: string | null; meta_description: string | null; og_image: string | null;
    status: 'draft' | 'published' | 'archived';
    is_active: boolean; is_homepage: boolean; auth_required: boolean;
    allowed_roles: string[]; sort_order: number; icon: string | null;
    kind: 'page' | 'popup';
    popup_config: Record<string, Any>;
    record_collection: string | null;
    record_field: string | null;
  };
  type MenuItem = { label: string; slug?: string; url?: string; external?: boolean };

  let sites = $state<Site[]>([]);
  let pages = $state<Page[]>([]);
  let collections = $state<string[]>([]);
  /** Column names per collection, so a data block's template can name real fields. */
  let collectionFields = $state<Record<string, string[]>>({});
  let activeSite = $state<Site | null>(null);
  let selected = $state<Page | null>(null);
  let view = $state<'sites' | 'pages' | 'edit' | 'menus' | 'site-settings' | 'redirects'>('sites');
  let loading = $state(true);
  let saving = $state(false);

  let showNewSite = $state(false);
  let showNewPage = $state(false);
  /** Creating a popup rather than a page — the same form, one flag different. */
  let newPageKind = $state<'page' | 'popup'>('page');
  /** The engine serves these from the renderer's own lists. */
  let iconNames = $state<string[]>([]);
  let motionTypes = $state<string[]>([]);
  let siteForm = $state({ name: '', slug: '', base_path: '', is_public: false });
  let pageForm = $state({ title: '', slug: '', auth_required: false });

  let menus = $state<{ main: MenuItem[]; footer: MenuItem[] }>({ main: [], footer: [] });
  let savingMenu = $state<'main' | 'footer' | null>(null);

  // ── Saved templates ─────────────────────────────────────────────────────
  type Template = { id: string; name: string; description: string | null; kind: string; blocks: Block[] };
  let templates = $state<Template[]>([]);
  let showSaveTemplate = $state(false);
  let templateName = $state('');

  // ── Page insights: revisions, SEO, metrics, variants ────────────────────
  //
  // Every one of these had a working endpoint and no screen — seven
  // capabilities finished and invisible. One panel rather than six pages,
  // because they are all answers about the page currently open.
  type Revision = { id: string; created_by: string | null; created_at: string };
  let insightsOpen = $state(false);
  let insightsTab = $state<'revisions' | 'seo' | 'metrics' | 'variants' | 'sitemap'>('revisions');
  let revisions = $state<Revision[]>([]);
  let seo = $state<Any | null>(null);
  let metrics = $state<Array<{ date: string; views: number; unique_visitors: number }>>([]);
  type Variant = { id: string; name: string; traffic_pct: number; views: number; conversions: number };
  let variants = $state<Variant[]>([]);
  let variantName = $state('');
  let sitemapCfg = $state({ include_in_sitemap: true, change_freq: 'weekly', priority: 0.5 });
  /** Page counts by status, for the sites screen. */
  let stats = $state<Any | null>(null);
  let insightsBusy = $state(false);

  // ── Redirects ───────────────────────────────────────────────────────────
  type Redirect = { id: string; from_path: string; to_path: string; redirect_type: number; hit_count: number };
  let redirects = $state<Redirect[]>([]);
  let redirectForm = $state({ from_path: '', to_path: '', redirect_type: 301 });

  // biome-ignore lint/suspicious/noExplicitAny: endpoint payloads are untyped
  type Any = any;

  // ── Builder state ───────────────────────────────────────────────────────
  //
  // The three-panel visual builder was added in April (0671dbf) and then lost
  // three weeks later: the v2 layout migration deleted `studio/src/pages/*.svelte`
  // as "v1 page wrappers, redundant". For 53 extensions they were. Here the file
  // it deleted WAS the builder, and the `studio/pages/+page.svelte` it kept as
  // "the real route" was the textarea editor the builder had replaced. The four
  // components survived, imported by nothing, until this merge.
  //
  // Restoring it also settles a vocabulary the two halves never agreed on: the
  // builder wrote `props`, the server reads `content` (engine/sanitize.ts,
  // engine/hydrate.ts), and it called a data block `data_table` where the server
  // says `collection_list`.
  let blocks = $state<Block[]>([]);
  let selectedId = $state<string | null>(null);
  // The canvas preview size AND the size the Style tab edits — one control, so
  // "make this narrower on phones" is: pick the phone, set the width.
  let device = $state<Breakpoint>('base');
  let history = $state<Block[][]>([]);
  let future = $state<Block[][]>([]);
  let savedFlash = $state(false);
  let titleEditing = $state(false);

  const selectedBlock = $derived(findById(blocks, selectedId));

  function commit(next: Block[]) {
    history = [...history, blocks];
    future = [];
    blocks = next;
  }
  function undo() {
    if (!history.length) return;
    future = [blocks, ...future];
    blocks = history[history.length - 1];
    history = history.slice(0, -1);
  }
  function redo() {
    if (!future.length) return;
    history = [...history, blocks];
    blocks = future[0];
    future = future.slice(1);
  }


  function slugify(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function extractError(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      if (typeof o.message === 'string') return o.message;
      if (typeof o.error === 'string') return o.error;
    }
    return m['common.unexpectedError']();
  }

  onMount(async () => {
    await Promise.all([
      loadSites(), loadCollections(), loadTemplates(), loadStats(), loadVocabulary(),
    ]);
    loading = false;
  });

  /** Page counts and traffic for the whole instance — shown above the sites. */
  async function loadStats() {
    try {
      stats = await api.get<Any>(`${BASE}/pages/stats`);
    } catch {
      stats = null;
    }
  }

  async function loadVocabulary() {
    try {
      const res = await api.get<{ icons: string[]; motion: string[] }>(`${BASE}/pages/vocabulary`);
      iconNames = res.icons ?? [];
      motionTypes = res.motion ?? [];
    } catch {
      iconNames = [];
      motionTypes = [];
    }
  }

  async function loadTemplates() {
    try {
      const res = await api.get<{ templates: Template[] }>(`${BASE}/pages/templates`);
      templates = res.templates ?? [];
    } catch {
      templates = [];
    }
  }

  async function saveTemplate() {
    const block = findById(blocks, selectedId);
    if (!block || !templateName.trim()) return;
    saving = true;
    try {
      await api.post(`${BASE}/pages/templates`, {
        name: templateName.trim(),
        kind: 'block',
        blocks: [block],
      });
      templateName = '';
      showSaveTemplate = false;
      await loadTemplates();
      toast.success(m['content.pages.toast.saved']());
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      saving = false;
    }
  }

  /**
   * Drop a saved template onto the page.
   *
   * Ids are regenerated, so inserting the same template twice does not put two
   * blocks with one id on the page — the canvas keys on id and would reuse the
   * wrong node.
   */
  function insertTemplate(t: Template) {
    const fresh = ensureIds(JSON.parse(JSON.stringify(t.blocks)).map((b: Block) => stripIds(b)));
    let next = blocks;
    for (const b of fresh) next = insertAt(next, null, next.length, b);
    commit(next);
    if (fresh[0]) selectedId = fresh[0].id;
  }

  /** Clear ids so `ensureIds` mints new ones at every depth. */
  function stripIds(b: Block): Block {
    const kids = (b.content?.children ?? []) as Block[];
    const tpl = b.content?.item_template as Block | undefined;
    return {
      ...b,
      id: undefined as unknown as string,
      content: {
        ...b.content,
        ...(Array.isArray(kids) && kids.length ? { children: kids.map(stripIds) } : {}),
        ...(tpl ? { item_template: stripIds(tpl) } : {}),
      },
    };
  }

  async function deleteTemplate(t: Template) {
    askConfirm(m['content.pages.confirmDeleteTemplate'](), async () => {
      try {
        await api.delete(`${BASE}/pages/templates/${t.id}`);
        templates = templates.filter((x) => x.id !== t.id);
      } catch (e) {
        toast.error(extractError(e));
      }
    });
  }

  // ── Insights ────────────────────────────────────────────────────────────

  async function openInsights() {
    if (!selected) return;
    insightsOpen = true;
    insightsBusy = true;
    try {
      const [rev, s, mt, vr] = await Promise.all([
        api.get<{ revisions: Revision[] }>(`${BASE}/pages/${selected.id}/revisions`),
        api.get<{ seo: Any }>(`${BASE}/pages/${selected.id}/seo`),
        api.get<{ metrics: Any[] }>(`${BASE}/pages/${selected.id}/metrics`),
        api.get<{ variants: Variant[] }>(`${BASE}/pages/${selected.id}/ab-variants`),
      ]);
      revisions = rev.revisions ?? [];
      seo = s.seo ?? null;
      metrics = (mt.metrics ?? []) as Any;
      variants = vr.variants ?? [];
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      insightsBusy = false;
    }
  }

  async function analyzeSeo() {
    if (!selected) return;
    insightsBusy = true;
    try {
      const res = await api.post<{ seo: Any }>(`${BASE}/pages/${selected.id}/seo/analyze`, {});
      seo = res.seo;
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      insightsBusy = false;
    }
  }

  function restoreRevision(r: Revision) {
    if (!selected) return;
    askConfirm(m['content.pages.confirmRestore'](), async () => {
      try {
        const res = await api.post<{ page: Page }>(
          `${BASE}/pages/${selected!.id}/revisions/${r.id}/restore`, {});
        selected = res.page;
        blocks = ensureIds(Array.isArray(res.page.blocks) ? res.page.blocks : []);
        history = [];
        future = [];
        selectedId = null;
        insightsOpen = false;
        toast.success(m['content.pages.toast.restored']());
      } catch (e) {
        toast.error(extractError(e));
      }
    });
  }

  /**
   * A variant is the page's current blocks under another name, with a share of
   * the traffic. Created from what is on screen, because "test this against what
   * I have" is the only sensible starting point.
   */
  async function addVariant() {
    if (!selected || !variantName.trim()) return;
    insightsBusy = true;
    try {
      const res = await api.post<{ variant: Variant }>(`${BASE}/pages/${selected.id}/ab-variants`, {
        name: variantName.trim(),
        blocks,
        traffic_pct: 50,
      });
      variants = [...variants, res.variant];
      variantName = '';
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      insightsBusy = false;
    }
  }

  function deleteVariant(v: Variant) {
    if (!selected) return;
    askConfirm(m['content.pages.confirmDeleteVariant'](), async () => {
      try {
        await api.delete(`${BASE}/pages/${selected!.id}/ab-variants/${v.id}`);
        variants = variants.filter((x) => x.id !== v.id);
      } catch (e) {
        toast.error(extractError(e));
      }
    });
  }

  async function saveSitemap() {
    if (!selected) return;
    insightsBusy = true;
    try {
      await api.post(`${BASE}/pages/sitemap-config`, {
        page_id: selected.id,
        include_in_sitemap: sitemapCfg.include_in_sitemap,
        change_freq: sitemapCfg.change_freq,
        priority: Number(sitemapCfg.priority),
      });
      toast.success(m['content.pages.toast.saved']());
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      insightsBusy = false;
    }
  }

  // ── Redirects ───────────────────────────────────────────────────────────

  async function openRedirects() {
    view = 'redirects';
    try {
      const res = await api.get<{ redirects: Redirect[] }>(`${BASE}/pages/redirects`);
      redirects = res.redirects ?? [];
    } catch (e) {
      toast.error(extractError(e));
    }
  }

  async function addRedirect() {
    if (!redirectForm.from_path.trim() || !redirectForm.to_path.trim()) return;
    saving = true;
    try {
      const res = await api.post<{ redirect: Redirect }>(`${BASE}/pages/redirects`, {
        from_path: redirectForm.from_path.trim(),
        to_path: redirectForm.to_path.trim(),
        redirect_type: redirectForm.redirect_type,
      });
      redirects = [res.redirect, ...redirects];
      redirectForm = { from_path: '', to_path: '', redirect_type: 301 };
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      saving = false;
    }
  }

  function deleteRedirect(r: Redirect) {
    askConfirm(m['content.pages.confirmDeleteRedirect'](), async () => {
      try {
        await api.delete(`${BASE}/pages/redirects/${r.id}`);
        redirects = redirects.filter((x) => x.id !== r.id);
      } catch (e) {
        toast.error(extractError(e));
      }
    });
  }

  async function loadSites() {
    try {
      const res = await api.get<{ sites: Site[] }>(`${BASE}/sites`);
      sites = res.sites ?? [];
    } catch (e) {
      toast.error(extractError(e));
      sites = [];
    }
  }

  /**
   * Collection names and their fields, so a data block is configured by picking
   * rather than by typing — the collection from a list, the template's
   * placeholders from the actual columns.
   */
  async function loadCollections() {
    try {
      const res = await api.get<{
        collections: Array<{ name: string; fields?: Array<{ name?: string } | string> }>;
      }>('/api/collections');
      const list = res.collections ?? [];
      collections = list.map((c) => c.name).sort();
      collectionFields = Object.fromEntries(
        list.map((c) => [
          c.name,
          (c.fields ?? [])
            .map((f) => (typeof f === 'string' ? f : f?.name))
            .filter((n): n is string => typeof n === 'string' && n.length > 0),
        ]),
      );
    } catch {
      collections = [];
      collectionFields = {};
    }
  }

  async function openSite(site: Site) {
    activeSite = site;
    view = 'pages';
    try {
      const res = await api.get<{ pages: Page[] }>(`${BASE}/sites/${site.slug}/pages`);
      pages = res.pages ?? [];
    } catch (e) {
      toast.error(extractError(e));
      pages = [];
    }
  }

  async function createSite() {
    if (!siteForm.name.trim() || !siteForm.slug.trim()) return;
    saving = true;
    try {
      const res = await api.post<{ site: Site }>(`${BASE}/sites`, {
        name: siteForm.name.trim(),
        slug: siteForm.slug.trim(),
        base_path: siteForm.base_path.trim() || `/${siteForm.slug.trim()}`,
        is_public: siteForm.is_public,
        is_active: true,
      });
      sites = [...sites, res.site];
      siteForm = { name: '', slug: '', base_path: '', is_public: false };
      showNewSite = false;
      await openSite(res.site);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      saving = false;
    }
  }

  async function saveSite() {
    if (!activeSite) return;
    saving = true;
    try {
      const res = await api.put<{ site: Site }>(`${BASE}/sites/${activeSite.slug}`, {
        name: activeSite.name,
        description: activeSite.description,
        is_active: activeSite.is_active,
        is_public: activeSite.is_public,
        access_roles: activeSite.access_roles,
        public_collections: activeSite.public_collections,
        base_path: activeSite.base_path,
        site_name: activeSite.site_name,
        site_logo_url: activeSite.site_logo_url,
        primary_color: activeSite.primary_color,
        nav_position: activeSite.nav_position,
        show_breadcrumbs: activeSite.show_breadcrumbs,
      });
      activeSite = res.site;
      sites = sites.map((s) => (s.id === res.site.id ? res.site : s));
      toast.success(m['content.pages.toast.saved']());
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      saving = false;
    }
  }

  function deleteSite(site: Site) {
    askConfirm(m['content.pages.confirmDeleteSite'](), async () => {
      try {
        await api.delete(`${BASE}/sites/${site.slug}`);
        sites = sites.filter((s) => s.id !== site.id);
        if (activeSite?.id === site.id) { activeSite = null; view = 'sites'; }
      } catch (e) {
        toast.error(extractError(e));
      }
    });
  }

  async function createPage() {
    if (!activeSite || !pageForm.title.trim() || !pageForm.slug.trim()) return;
    saving = true;
    try {
      const res = await api.post<{ page: Page }>(`${BASE}/sites/${activeSite.slug}/pages`, {
        title: pageForm.title.trim(),
        slug: pageForm.slug.trim(),
        blocks: [],
        status: 'draft',
        kind: newPageKind,
        // A popup is drawn over a page, never navigated to, so it is never
        // behind its own role gate — the page it appears on decides that.
        auth_required: newPageKind === 'popup' ? false : pageForm.auth_required,
      });
      pages = [...pages, res.page];
      pageForm = { title: '', slug: '', auth_required: !activeSite.is_public };
      showNewPage = false;
      openEdit(res.page);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      saving = false;
    }
  }

  function openEdit(p: Page) {
    selected = JSON.parse(JSON.stringify(p));
    // Every block needs a stable id: the canvas keys on it and the properties
    // panel selects by it. Migrated blocks carry the `zvd_page_views` row id;
    // anything authored before the builder came back has none.
    // Recursively, because a container's children need ids just as much as the
    // blocks beside it — the canvas keys on id at every depth.
    blocks = ensureIds(Array.isArray(selected!.blocks) ? selected!.blocks : []);
    selectedId = null;
    history = [];
    future = [];
    view = 'edit';
  }

  /**
   * Clicking a block in the library adds it INSIDE the current selection when
   * that selection is a container, and at the end of the page otherwise. That is
   * what an author means by clicking `Image` while a container is selected, and
   * it saves a drag for the common case.
   */
  function onAdd(block: Block) {
    const selectedBlk = findById(blocks, selectedId);
    if (selectedBlk && isContainer(selectedBlk)) {
      const kids = (selectedBlk.content?.children ?? []) as Block[];
      commit(insertAt(blocks, selectedBlk.id, kids.length, block));
    } else {
      commit(insertAt(blocks, null, blocks.length, block));
    }
    selectedId = block.id;
  }

  function onPatch(fn: (b: Block) => Block) {
    if (!selectedId) return;
    commit(patchById(blocks, selectedId, fn));
  }

  function onKeydown(e: KeyboardEvent) {
    if (view !== 'edit') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (mod && e.key === 's') { e.preventDefault(); savePage(); return; }
    if (e.key === 'Escape') { selectedId = null; return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      const active = document.activeElement;
      if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
      e.preventDefault();
      commit(removeById(blocks, selectedId));
      selectedId = null;
    }
  }

  onMount(() => { window.addEventListener('keydown', onKeydown); });
  onDestroy(() => { window.removeEventListener('keydown', onKeydown); });

  async function savePage(status?: Page['status']) {
    if (!selected || !activeSite) return;
    saving = true;
    try {
      const res = await api.put<{ page: Page }>(
        `${BASE}/sites/${activeSite.slug}/pages/${selected.slug}`,
        {
          title: selected.title,
          slug: selected.slug,
          blocks,
          status: status ?? selected.status,
          is_active: selected.is_active,
          is_homepage: selected.is_homepage,
          auth_required: selected.auth_required,
          allowed_roles: selected.allowed_roles,
          icon: selected.icon ?? undefined,
          kind: selected.kind,
          popup_config: selected.popup_config ?? {},
          record_collection: selected.record_collection || null,
          record_field: selected.record_field || null,
        },
      );
      selected = res.page;
      pages = pages.map((p) => (p.id === res.page.id ? res.page : p));
      savedFlash = true;
      setTimeout(() => (savedFlash = false), 2000);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      saving = false;
    }
  }

  function deletePage(p: Page) {
    if (!activeSite) return;
    askConfirm(m['content.pages.confirmDeletePage'](), async () => {
      try {
        await api.delete(`${BASE}/sites/${activeSite!.slug}/pages/${p.slug}`);
        pages = pages.filter((x) => x.id !== p.id);
        if (selected?.id === p.id) { selected = null; view = 'pages'; }
      } catch (e) {
        toast.error(extractError(e));
      }
    });
  }


  // ── Blocks ────────────────────────────────────────────────────────────────



  // ── Menus ─────────────────────────────────────────────────────────────────

  async function openMenus() {
    view = 'menus';
    try {
      const res = await api.get<{ menus: { main: MenuItem[]; footer: MenuItem[] } }>(`${BASE}/pages/menus`);
      menus = { main: res.menus?.main ?? [], footer: res.menus?.footer ?? [] };
    } catch (e) {
      toast.error(extractError(e));
    }
  }
  function addMenuItem(key: 'main' | 'footer') {
    menus[key] = [...menus[key], { label: 'New link', slug: '' }];
  }
  function removeMenuItem(key: 'main' | 'footer', idx: number) {
    menus[key] = menus[key].filter((_, i) => i !== idx);
  }
  async function saveMenu(key: 'main' | 'footer') {
    savingMenu = key;
    try {
      const items = menus[key].map((i) =>
        i.external ? { label: i.label, url: i.url, external: true } : { label: i.label, slug: i.slug },
      );
      await api.put(`${BASE}/pages/menus/${key}`, { items });
      toast.success(m['content.pages.toast.saved']());
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      savingMenu = null;
    }
  }

  /** One popup setting, merged into its config. */
  function setPopup(key: string, value: Any) {
    if (!selected) return;
    selected.popup_config = { ...(selected.popup_config ?? {}), [key]: value };
  }

  function togglePublicCollection(name: string) {
    if (!activeSite) return;
    const cur = activeSite.public_collections ?? [];
    activeSite.public_collections = cur.includes(name)
      ? cur.filter((c) => c !== name)
      : [...cur, name];
  }
</script>

<ExtensionPageShell title={m['content.pages.title']()} subtitle={m['content.pages.subtitle']()}>
  {#snippet actions()}
    {#if view === 'sites'}
      <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showNewSite = true)}>
        <Plus size={14} /> {m['content.pages.newSite']()}
      </button>
    {:else if view === 'pages'}
      <button type="button" class="btn btn-ghost btn-sm gap-1" onclick={() => { view = 'sites'; activeSite = null; }}>
        <ArrowLeft size={14} /> {m['content.pages.allSites']()}
      </button>
      <button type="button" class="btn btn-ghost btn-sm gap-1" onclick={() => (view = 'site-settings')}>
        <Settings size={14} /> {m['content.pages.siteSettings']()}
      </button>
      <button type="button" class="btn btn-ghost btn-sm gap-1" onclick={openMenus}>
        <MenuIcon size={14} /> {m['content.pages.menus.title']()}
      </button>
      <button type="button" class="btn btn-ghost btn-sm gap-1" onclick={openRedirects}>
        <CornerDownRight size={14} /> {m['content.pages.redirects.title']()}
      </button>
      <button type="button" class="btn btn-ghost btn-sm gap-1"
        onclick={() => { newPageKind = 'popup'; showNewPage = true; }}>
        <Plus size={14} /> {m['content.pages.newPopup']()}
      </button>
      <button type="button" class="btn btn-primary btn-sm gap-1"
        onclick={() => {
          newPageKind = 'page';
          pageForm = { ...pageForm, auth_required: !(activeSite?.is_public ?? false) };
          showNewPage = true;
        }}>
        <Plus size={14} /> {m['content.pages.newPage']()}
      </button>
    {:else}
      <button type="button" class="btn btn-ghost btn-sm gap-1" onclick={() => { view = 'pages'; selected = null; }}>
        <ArrowLeft size={14} /> {m['common.close']()}
      </button>
    {/if}
  {/snippet}

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>

  {:else if view === 'sites'}
    {#if stats}
      <!-- Counts across every site. The endpoint existed and nothing called it. -->
      <div class="flex flex-wrap gap-2 mb-4">
        {#each (stats.by_status ?? []) as row (row.status)}
          <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-1.5">
            <span class="text-lg font-semibold tabular-nums">{row.count}</span>
            <span class="text-xs text-base-content/60 ml-1">{row.status}</span>
          </div>
        {/each}
        {#if stats.views_last_30_days}
          <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-1.5">
            <span class="text-lg font-semibold tabular-nums">{stats.views_last_30_days}</span>
            <span class="text-xs text-base-content/60 ml-1">{m['content.pages.insights.views30']()}</span>
          </div>
        {/if}
        {#if stats.avg_seo_score}
          <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-1.5">
            <span class="text-lg font-semibold tabular-nums">{stats.avg_seo_score}</span>
            <span class="text-xs text-base-content/60 ml-1">{m['content.pages.insights.avgSeo']()}</span>
          </div>
        {/if}
      </div>
    {/if}
    {#if sites.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">
        {m['content.pages.empty.sites']()}
      </div></div>
    {:else}
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {#each sites as s (s.id)}
          <div class="card bg-base-200 border border-base-300 hover:border-primary/50 transition-colors">
            <div class="card-body p-4 gap-2">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <h3 class="font-semibold text-sm truncate">{s.name}</h3>
                  <p class="font-mono text-xs text-base-content/50 truncate">{s.base_path}</p>
                </div>
                <span class="badge badge-sm gap-1 {s.is_public ? 'badge-success' : 'badge-ghost'}">
                  {#if s.is_public}<Globe size={11} /> {m['content.pages.public']()}
                  {:else}<Lock size={11} /> {m['content.pages.private']()}{/if}
                </span>
              </div>
              {#if s.access_roles?.length}
                <p class="text-xs text-base-content/60">
                  {m['content.pages.roles']()}: {s.access_roles.join(', ')}
                </p>
              {/if}
              <div class="flex items-center gap-1 pt-1">
                <button class="btn btn-primary btn-xs gap-1" onclick={() => openSite(s)}>
                  <FileText size={12} /> {m['content.pages.openPages']()}
                </button>
                {#if !s.is_active}
                  <span class="badge badge-warning badge-xs">{m['content.pages.inactive']()}</span>
                {/if}
                <button class="btn btn-ghost btn-xs text-error ml-auto" onclick={() => deleteSite(s)}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}

  {:else if view === 'site-settings' && activeSite}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-4 gap-3">
          <p class="text-xs font-medium text-base-content/70 uppercase tracking-wider">
            {m['content.pages.section.branding']()}
          </p>
          <label class="form-control gap-1"><span class="label-text text-xs">{m['content.pages.field.name']()}</span>
            <input class="input input-sm" bind:value={activeSite.name} /></label>
          <label class="form-control gap-1"><span class="label-text text-xs">{m['content.pages.field.basePath']()}</span>
            <input class="input input-sm font-mono" bind:value={activeSite.base_path} /></label>
          <label class="form-control gap-1"><span class="label-text text-xs">{m['content.pages.field.siteName']()}</span>
            <input class="input input-sm" bind:value={activeSite.site_name} /></label>
          <label class="form-control gap-1"><span class="label-text text-xs">{m['content.pages.field.logoUrl']()}</span>
            <input class="input input-sm font-mono" bind:value={activeSite.site_logo_url} /></label>
          <label class="form-control gap-1"><span class="label-text text-xs">{m['content.pages.field.primaryColor']()}</span>
            <input type="color" class="input input-sm h-9 w-20 p-1" bind:value={activeSite.primary_color} /></label>
          <label class="label cursor-pointer justify-start gap-2">
            <input type="checkbox" class="toggle toggle-sm" bind:checked={activeSite.is_active} />
            <span class="label-text text-xs">{m['content.pages.field.active']()}</span>
          </label>
        </div>
      </div>

      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-4 gap-3">
          <p class="text-xs font-medium text-base-content/70 uppercase tracking-wider">
            {m['content.pages.section.access']()}
          </p>
          <label class="label cursor-pointer justify-start gap-2">
            <input type="checkbox" class="toggle toggle-sm" bind:checked={activeSite.is_public} />
            <span class="label-text text-xs">{m['content.pages.field.isPublic']()}</span>
          </label>
          <label class="form-control gap-1"><span class="label-text text-xs">{m['content.pages.field.accessRoles']()}</span>
            <input class="input input-sm" placeholder="client, partner"
              value={(activeSite.access_roles ?? []).join(', ')}
              oninput={(e) => { if (activeSite) activeSite.access_roles = (e.currentTarget as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean); }} />
          </label>

          <div class="divider my-1"></div>
          <p class="text-xs font-medium text-base-content/70 uppercase tracking-wider">
            {m['content.pages.section.publicData']()}
          </p>
          <p class="text-xs text-base-content/60">{m['content.pages.publicData.help']()}</p>
          {#if !activeSite.is_public}
            <p class="text-xs text-base-content/40">{m['content.pages.publicData.onlyPublic']()}</p>
          {:else if collections.length === 0}
            <p class="text-xs text-base-content/40">{m['content.pages.publicData.noCollections']()}</p>
          {:else}
            <div class="max-h-56 overflow-y-auto rounded bg-base-100 p-2 space-y-1">
              {#each collections as col (col)}
                <label class="label cursor-pointer justify-start gap-2 py-0.5">
                  <input type="checkbox" class="checkbox checkbox-xs"
                    checked={(activeSite.public_collections ?? []).includes(col)}
                    onchange={() => togglePublicCollection(col)} />
                  <span class="label-text text-xs font-mono">{col}</span>
                </label>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>
    <button class="btn btn-primary btn-sm mt-4 gap-1" onclick={saveSite} disabled={saving}>
      {#if saving}<LoaderCircle size={13} class="animate-spin" />{:else}<Save size={14} />{/if} {m['common.save']()}
    </button>

  {:else if view === 'pages' && activeSite}
    {#if pages.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">
        {m['content.pages.empty.pages']()}
      </div></div>
    {:else}
      <div class="overflow-x-auto rounded-xl border border-base-300/60 bg-base-100">
        <table class="table table-sm">
          <thead><tr>
            <th>{m['content.pages.col.title']()}</th>
            <th>{m['content.pages.col.slug']()}</th>
            <th>{m['common.col.status']()}</th>
            <th>{m['content.pages.col.access']()}</th>
            <th></th>
          </tr></thead>
          <tbody>
            {#each pages as p (p.id)}
              <tr class="hover">
                <td class="font-medium">{p.title}
                  {#if p.is_homepage}<span class="badge badge-xs badge-primary">{m['content.pages.homepage']()}</span>{/if}
                  {#if p.kind === 'popup'}<span class="badge badge-xs badge-secondary">{m['content.pages.popup']()}</span>{/if}
                </td>
                <td class="font-mono text-xs">
                  {#if p.kind === 'popup'}<span class="opacity-40">{m['content.pages.popupNoAddress']()}</span>
                  {:else}{activeSite.base_path}/{p.slug}{/if}
                </td>
                <td><span class="badge badge-sm {p.status === 'published' ? 'badge-success' : 'badge-ghost'}">{p.status}</span></td>
                <td>
                  {#if p.auth_required}
                    <span class="badge badge-sm badge-warning gap-1"><Lock size={10} /> {p.allowed_roles?.length ? p.allowed_roles.join(', ') : m['content.pages.anySignedIn']()}</span>
                  {:else}
                    <span class="badge badge-sm badge-ghost gap-1"><Globe size={10} /> {m['content.pages.public']()}</span>
                  {/if}
                </td>
                <td class="text-right">
                  <button class="btn btn-ghost btn-xs gap-1" onclick={() => openEdit(p)}><FileText size={13} /> {m['common.edit']()}</button>
                  <button class="btn btn-ghost btn-xs text-error" onclick={() => deletePage(p)}><Trash2 size={13} /></button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  {:else if view === 'edit' && selected}
    <!--
      The three-panel builder: library on the left, canvas in the middle,
      properties on the right. Undo/redo, device preview and the keyboard
      shortcuts come with it.
    -->
    <div class="flex flex-col h-[calc(100vh-11rem)] -mx-4 -mb-4 overflow-hidden bg-base-200 rounded-lg border border-base-300">

      <header class="flex items-center justify-between gap-3 px-3 py-2 bg-base-100 border-b border-base-300 shrink-0">
        <div class="flex items-center gap-2 min-w-0">
          {#if titleEditing}
            <input class="input input-xs font-semibold max-w-[220px]" bind:value={selected.title}
              onblur={() => (titleEditing = false)}
              onkeydown={(e) => e.key === 'Enter' && (titleEditing = false)} />
          {:else}
            <button class="text-sm font-semibold truncate max-w-[220px] hover:text-primary transition-colors text-left"
              onclick={() => (titleEditing = true)}>{selected.title}</button>
          {/if}
          <span class="text-xs text-base-content/30 font-mono truncate hidden sm:block">
            {activeSite?.base_path}/{selected.slug}
          </span>
          <span class="badge badge-xs shrink-0 {selected.status === 'published' ? 'badge-success' : 'badge-warning'}">
            {selected.status}
          </span>
          {#if selected.auth_required}
            <span class="badge badge-xs badge-ghost gap-1 shrink-0"><Lock size={9} /></span>
          {/if}
        </div>

        <div class="flex items-center gap-0.5 bg-base-200 rounded-lg p-0.5 shrink-0">
          {#each ([['base', Smartphone], ['tablet', Tablet], ['desktop', Monitor]] as const) as [mode, Icon] (mode)}
            <button title={BREAKPOINT_LABEL[mode]} onclick={() => (device = mode)}
              class="p-1.5 rounded-md transition-colors {device === mode ? 'bg-base-100 shadow-sm text-primary' : 'text-base-content/40 hover:text-base-content'}"
            ><Icon size={14} /></button>
          {/each}
        </div>

        <div class="flex items-center gap-1 shrink-0">
          <button class="btn btn-ghost btn-xs" onclick={undo} disabled={!history.length} title="Ctrl+Z"><RotateCcw size={13} /></button>
          <button class="btn btn-ghost btn-xs" onclick={redo} disabled={!future.length} title="Ctrl+Y"><RotateCw size={13} /></button>
          <div class="h-4 w-px bg-base-300 mx-0.5"></div>
          <button class="btn btn-ghost btn-xs gap-1" onclick={openInsights}
            title={m['content.pages.insights.title']()}><Gauge size={13} /></button>
          <button class="btn btn-ghost btn-xs gap-1" onclick={() => (view = 'pages')}>
            <ArrowLeft size={12} /> {m['content.pages.openPages']()}
          </button>
          <button class="btn btn-ghost btn-xs gap-1"
            onclick={() => savePage(selected.status === 'published' ? 'draft' : 'published')}>
            <Globe size={12} />
            {selected.status === 'published' ? m['content.pages.unpublish']() : m['common.publish']()}
          </button>
          <button class="btn btn-primary btn-xs gap-1" onclick={() => savePage()} disabled={saving}>
            {#if saving}<LoaderCircle size={12} class="animate-spin" />
            {:else if savedFlash}<Check size={12} />
            {:else}<Save size={12} />{/if}
            {savedFlash ? m['content.pages.toast.saved']() : m['common.save']()}
          </button>
        </div>
      </header>

      <div class="flex flex-1 overflow-hidden">
        <div class="flex flex-col">
          <BlockLibrary {onAdd} />
          <div class="w-52 shrink-0 border-t border-r border-base-300 bg-base-100 p-2 space-y-1
            max-h-56 overflow-y-auto">
            <p class="text-[10px] font-bold text-base-content/40 uppercase tracking-widest px-1">
              {m['content.pages.templates.title']()}
            </p>
            {#each templates as t (t.id)}
              <div class="flex items-center gap-1">
                <button class="btn btn-ghost btn-xs flex-1 justify-start truncate"
                  onclick={() => insertTemplate(t)} title={t.name}>{t.name}</button>
                <button class="btn btn-ghost btn-xs text-error px-1"
                  onclick={() => deleteTemplate(t)}><Trash2 size={11} /></button>
              </div>
            {/each}
            {#if templates.length === 0}
              <p class="text-[10px] text-base-content/30 px-1 py-1">{m['content.pages.templates.empty']()}</p>
            {/if}
            <button class="btn btn-xs btn-ghost w-full border border-dashed border-base-300 gap-1"
              disabled={!selectedId}
              onclick={() => (showSaveTemplate = true)}>
              <BookmarkPlus size={11} /> {m['content.pages.templates.save']()}
            </button>
          </div>
        </div>
        <Canvas {blocks} {selectedId} {device} onChange={commit} onSelect={(id) => (selectedId = id)} />
        {#if selectedBlock}
          <PropertiesPanel
            block={selectedBlock}
            {onPatch}
            {collections}
            {collectionFields}
            {device}
            {iconNames}
            {motionTypes}
            sitePublic={activeSite?.is_public ?? false}
            publicCollections={activeSite?.public_collections ?? []}
          />
        {:else}
          <div class="w-64 shrink-0 bg-base-100 border-l border-base-300 flex flex-col overflow-y-auto">
            <div class="px-3 py-2.5 border-b border-base-300">
              <span class="text-[10px] font-bold text-base-content/40 uppercase tracking-widest">
                {m['content.pages.section.settings']()}
              </span>
            </div>
            <div class="p-3 space-y-2.5">
              <label class="form-control gap-1"><span class="label-text text-[10px]">{m['content.pages.col.slug']()}</span>
                <input class="input input-xs font-mono" bind:value={selected.slug} /></label>
              <label class="label cursor-pointer justify-start gap-2 py-0">
                <input type="checkbox" class="toggle toggle-xs" bind:checked={selected.is_homepage} />
                <span class="label-text text-[10px]">{m['content.pages.homepage']()}</span>
              </label>
              {#if selected.kind !== 'popup'}
                <!--
                  A record page. Naming a collection here turns the page into the
                  page OF one row: `/products/chair`. Every `{{field}}` in its
                  blocks then resolves against that row — the same substitution
                  a data block's item template uses.
                -->
                <div class="pt-1 border-t border-base-300 space-y-1.5">
                  <p class="text-[10px] font-bold text-base-content/40 uppercase tracking-widest">
                    {m['content.pages.record.title']()}
                  </p>
                  <label class="form-control gap-1">
                    <span class="label-text text-[10px]">{m['content.pages.record.collection']()}</span>
                    <select class="select select-xs" value={selected.record_collection ?? ''}
                      onchange={(e) => { if (selected) selected.record_collection = e.currentTarget.value || null; }}>
                      <option value="">{m['content.pages.record.none']()}</option>
                      {#each collections as col (col)}<option value={col}>{col}</option>{/each}
                    </select>
                  </label>
                  {#if selected.record_collection}
                    <label class="form-control gap-1">
                      <span class="label-text text-[10px]">{m['content.pages.record.field']()}</span>
                      <select class="select select-xs" value={selected.record_field ?? 'slug'}
                        onchange={(e) => { if (selected) selected.record_field = e.currentTarget.value; }}>
                        {#each (collectionFields[selected.record_collection] ?? ['slug', 'id']) as f (f)}
                          <option value={f}>{f}</option>
                        {/each}
                      </select>
                    </label>
                    <p class="text-[9px] text-base-content/40 leading-snug font-mono">
                      {activeSite?.base_path}/{selected.slug}/&lt;{selected.record_field ?? 'slug'}&gt;
                    </p>
                    <p class="text-[9px] text-base-content/40 leading-snug">
                      {m['content.pages.record.hint']()}
                    </p>
                  {/if}
                </div>
              {/if}

              {#if selected.kind === 'popup'}
                <!--
                  A popup is drawn over a page, so what it needs is when to
                  appear and where — not a slug and a role. The role that
                  matters belongs to the page it appears on.
                -->
                <div>{@render popupSettings()}</div>
              {:else}
                <div>
                  <span class="label-text text-[10px]">{m['content.pages.visibility.label']()}</span>
                  <div class="grid grid-cols-2 gap-1 mt-1">
                    <button type="button"
                      class="btn btn-xs gap-1 {!selected.auth_required ? 'btn-primary' : 'btn-ghost border border-base-300'}"
                      onclick={() => { if (selected) selected.auth_required = false; }}>
                      <Globe size={11} /> {m['content.pages.visibility.public']()}
                    </button>
                    <button type="button"
                      class="btn btn-xs gap-1 {selected.auth_required ? 'btn-primary' : 'btn-ghost border border-base-300'}"
                      onclick={() => { if (selected) selected.auth_required = true; }}>
                      <Lock size={11} /> {m['content.pages.visibility.private']()}
                    </button>
                  </div>
                </div>
              {/if}
              {#if selected.auth_required}
                <label class="form-control gap-1"><span class="label-text text-[10px]">{m['content.pages.field.allowedRoles']()}</span>
                  <input class="input input-xs" placeholder="client, partner"
                    value={(selected.allowed_roles ?? []).join(', ')}
                    oninput={(e) => { if (selected) selected.allowed_roles = (e.currentTarget as HTMLInputElement).value.split(',').map((v) => v.trim()).filter(Boolean); }} />
                </label>
              {/if}
              <p class="text-[10px] text-base-content/40 leading-relaxed pt-1">
                {m['content.pages.selectBlockHint']()}
              </p>
            </div>
          </div>
        {/if}
      </div>
    </div>

  {:else if view === 'redirects'}
    <!--
      Redirects have worked since the merge and had no screen — the endpoints
      were there, nothing called them. Same for the SEO score, the metrics, the
      A/B variants and the revisions, which live in the Insights panel.
    -->
    <div class="card bg-base-200 border border-base-300 mb-4">
      <div class="card-body p-4 gap-2">
        <p class="text-xs font-medium text-base-content/70 uppercase tracking-wider">
          {m['content.pages.redirects.add']()}
        </p>
        <div class="flex flex-wrap gap-2 items-end">
          <label class="form-control gap-1 flex-1 min-w-[12rem]">
            <span class="label-text text-xs">{m['content.pages.redirects.from']()}</span>
            <input class="input input-sm font-mono" placeholder="/old-page" bind:value={redirectForm.from_path} />
          </label>
          <label class="form-control gap-1 flex-1 min-w-[12rem]">
            <span class="label-text text-xs">{m['content.pages.redirects.to']()}</span>
            <input class="input input-sm font-mono" placeholder="/new-page" bind:value={redirectForm.to_path} />
          </label>
          <label class="form-control gap-1">
            <span class="label-text text-xs">{m['content.pages.redirects.type']()}</span>
            <select class="select select-sm" bind:value={redirectForm.redirect_type}>
              <option value={301}>301 {m['content.pages.redirects.permanent']()}</option>
              <option value={302}>302 {m['content.pages.redirects.temporary']()}</option>
            </select>
          </label>
          <button class="btn btn-primary btn-sm" onclick={addRedirect}
            disabled={saving || !redirectForm.from_path || !redirectForm.to_path}>
            <Plus size={14} /> {m['common.create']()}
          </button>
        </div>
      </div>
    </div>

    {#if redirects.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">
        {m['content.pages.redirects.empty']()}
      </div></div>
    {:else}
      <div class="overflow-x-auto rounded-xl border border-base-300/60 bg-base-100">
        <table class="table table-sm">
          <thead><tr>
            <th>{m['content.pages.redirects.from']()}</th>
            <th>{m['content.pages.redirects.to']()}</th>
            <th>{m['content.pages.redirects.type']()}</th>
            <th class="text-right">{m['content.pages.redirects.hits']()}</th>
            <th></th>
          </tr></thead>
          <tbody>
            {#each redirects as r (r.id)}
              <tr class="hover">
                <td class="font-mono text-xs">{r.from_path}</td>
                <td class="font-mono text-xs">{r.to_path}</td>
                <td><span class="badge badge-sm badge-ghost">{r.redirect_type}</span></td>
                <td class="text-right tabular-nums">{r.hit_count}</td>
                <td class="text-right">
                  <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteRedirect(r)}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  {:else if view === 'menus'}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      {#each [['main', m['content.pages.menus.main']()], ['footer', m['content.pages.menus.footer']()]] as [key, label] (key)}
        {@const k = key as 'main' | 'footer'}
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-4 gap-2">
            <div class="flex items-center justify-between">
              <h3 class="font-semibold text-sm">{label}</h3>
              <button class="btn btn-ghost btn-xs gap-1" onclick={() => addMenuItem(k)}><Plus size={12} /> {m['content.pages.menus.addItem']()}</button>
            </div>
            {#each menus[k] as item, idx (idx)}
              <div class="flex items-center gap-1 bg-base-100 rounded p-1.5">
                <input class="input input-xs w-28" bind:value={item.label} placeholder={m['content.pages.menus.label']()} />
                {#if item.external}
                  <input class="input input-xs flex-1 font-mono" bind:value={item.url} placeholder="https://…" />
                {:else}
                  <input class="input input-xs flex-1 font-mono" bind:value={item.slug} placeholder="slug" />
                {/if}
                <label class="label cursor-pointer gap-1 px-1">
                  <input type="checkbox" class="checkbox checkbox-xs" bind:checked={item.external} />
                  <span class="text-[10px]">{m['content.pages.menus.external']()}</span>
                </label>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => removeMenuItem(k, idx)}><X size={12} /></button>
              </div>
            {/each}
            {#if menus[k].length === 0}<p class="text-xs text-base-content/40 py-3 text-center">{m['content.pages.menus.empty']()}</p>{/if}
            <button class="btn btn-primary btn-xs w-full mt-1 gap-1" onclick={() => saveMenu(k)} disabled={savingMenu === k}>
              {#if savingMenu === k}<LoaderCircle size={12} class="animate-spin" />{:else}<Save size={12} />{/if} {m['common.save']()}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</ExtensionPageShell>

{#snippet popupSettings()}
  {#if selected}
    {@const cfg = selected.popup_config ?? {}}
    <div class="space-y-2">
      <label class="form-control gap-1">
        <span class="label-text text-[10px]">{m['content.pages.popup.trigger']()}</span>
        <select class="select select-xs" value={cfg.trigger ?? 'delay'}
          onchange={(e) => setPopup('trigger', e.currentTarget.value)}>
          <option value="load">{m['content.pages.popup.onLoad']()}</option>
          <option value="delay">{m['content.pages.popup.afterDelay']()}</option>
          <option value="scroll">{m['content.pages.popup.onScroll']()}</option>
          <option value="exit">{m['content.pages.popup.onExit']()}</option>
          <option value="click">{m['content.pages.popup.onClick']()}</option>
        </select>
      </label>

      {#if (cfg.trigger ?? 'delay') === 'delay'}
        <label class="form-control gap-1">
          <span class="label-text text-[10px]">{m['content.pages.popup.delaySeconds']()}</span>
          <input type="number" min="0" max="120" class="input input-xs" value={cfg.delay_seconds ?? 3}
            oninput={(e) => setPopup('delay_seconds', Number(e.currentTarget.value))} />
        </label>
      {:else if cfg.trigger === 'scroll'}
        <label class="form-control gap-1">
          <span class="label-text text-[10px]">{m['content.pages.popup.scrollPercent']()}</span>
          <input type="number" min="1" max="100" class="input input-xs" value={cfg.scroll_percent ?? 50}
            oninput={(e) => setPopup('scroll_percent', Number(e.currentTarget.value))} />
        </label>
      {:else if cfg.trigger === 'click'}
        <label class="form-control gap-1">
          <span class="label-text text-[10px]">{m['content.pages.popup.selector']()}</span>
          <input class="input input-xs font-mono" placeholder=".open-offer" value={cfg.selector ?? ''}
            oninput={(e) => setPopup('selector', e.currentTarget.value)} />
        </label>
      {/if}

      <label class="form-control gap-1">
        <span class="label-text text-[10px]">{m['content.pages.popup.frequency']()}</span>
        <select class="select select-xs" value={cfg.frequency ?? 'session'}
          onchange={(e) => setPopup('frequency', e.currentTarget.value)}>
          <option value="always">{m['content.pages.popup.always']()}</option>
          <option value="session">{m['content.pages.popup.session']()}</option>
          <option value="once">{m['content.pages.popup.once']()}</option>
        </select>
      </label>

      <div class="grid grid-cols-2 gap-1.5">
        <label class="form-control gap-1">
          <span class="label-text text-[10px]">{m['content.pages.popup.position']()}</span>
          <select class="select select-xs" value={cfg.position ?? 'center'}
            onchange={(e) => setPopup('position', e.currentTarget.value)}>
            <option value="center">{m['content.pages.popup.center']()}</option>
            <option value="top">{m['content.pages.popup.top']()}</option>
            <option value="bottom">{m['content.pages.popup.bottom']()}</option>
          </select>
        </label>
        <label class="form-control gap-1">
          <span class="label-text text-[10px]">{m['content.pages.popup.width']()}</span>
          <input type="number" min="240" max="1200" step="20" class="input input-xs"
            value={cfg.width ?? 560}
            oninput={(e) => setPopup('width', Number(e.currentTarget.value))} />
        </label>
      </div>

      <label class="form-control gap-1">
        <span class="label-text text-[10px]">{m['content.pages.popup.targets']()}</span>
        <input class="input input-xs font-mono" placeholder="home, pricing"
          value={(cfg.targets ?? []).join(', ')}
          oninput={(e) => setPopup('targets', e.currentTarget.value.split(',').map((t) => t.trim()).filter(Boolean))} />
      </label>
      <p class="text-[9px] text-base-content/40 leading-snug">{m['content.pages.popup.targetsHint']()}</p>
    </div>
  {/if}
{/snippet}

{#if showNewSite}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['content.pages.newSite']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showNewSite = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <label class="form-control gap-1"><span class="label-text text-xs">{m['content.pages.field.name']()}</span>
          <input class="input input-sm" bind:value={siteForm.name}
            oninput={() => { if (!siteForm.slug) siteForm.slug = slugify(siteForm.name); }} /></label>
        <label class="form-control gap-1"><span class="label-text text-xs">{m['content.pages.col.slug']()}</span>
          <input class="input input-sm font-mono" bind:value={siteForm.slug} /></label>
        <label class="form-control gap-1"><span class="label-text text-xs">{m['content.pages.field.basePath']()}</span>
          <input class="input input-sm font-mono" bind:value={siteForm.base_path} placeholder="/{siteForm.slug || 'site'}" /></label>
        <label class="label cursor-pointer justify-start gap-2">
          <input type="checkbox" class="toggle toggle-sm" bind:checked={siteForm.is_public} />
          <span class="label-text text-xs">{m['content.pages.field.isPublic']()}</span>
        </label>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showNewSite = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !siteForm.name || !siteForm.slug} onclick={createSite}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} {m['common.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showNewPage}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['content.pages.newPage']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showNewPage = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <label class="form-control gap-1"><span class="label-text text-xs">{m['content.pages.col.title']()}</span>
          <input class="input input-sm" bind:value={pageForm.title}
            oninput={() => { if (!pageForm.slug) pageForm.slug = slugify(pageForm.title); }} /></label>
        <label class="form-control gap-1"><span class="label-text text-xs">{m['content.pages.col.slug']()}</span>
          <input class="input input-sm font-mono" bind:value={pageForm.slug} /></label>
        {#if newPageKind === 'page'}
          <!--
            Two named options rather than a checkbox. "Requires sign-in: off" and
            "Public" are the same fact, but only one of them is what an author is
            deciding, and this is the decision they have in mind while creating
            the page. The default follows the site.

            The choice is stored on the page (`auth_required`), not in the URL:
            a page can be moved between public and private without anything
            moving, which a route-shaped answer could not do.
          -->
          <div>
            <span class="label-text text-xs">{m['content.pages.visibility.label']()}</span>
            <div class="grid grid-cols-2 gap-2 mt-1">
              <button type="button"
                class="btn btn-sm justify-start gap-2 {!pageForm.auth_required ? 'btn-primary' : 'btn-ghost border border-base-300'}"
                onclick={() => (pageForm.auth_required = false)}>
                <Globe size={14} /> {m['content.pages.visibility.public']()}
              </button>
              <button type="button"
                class="btn btn-sm justify-start gap-2 {pageForm.auth_required ? 'btn-primary' : 'btn-ghost border border-base-300'}"
                onclick={() => (pageForm.auth_required = true)}>
                <Lock size={14} /> {m['content.pages.visibility.private']()}
              </button>
            </div>
            <p class="text-[10px] text-base-content/50 mt-1 leading-snug">
              {pageForm.auth_required ? m['content.pages.visibility.privateHint']() : m['content.pages.visibility.publicHint']()}
            </p>
          </div>
        {/if}
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showNewPage = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !pageForm.title || !pageForm.slug} onclick={createPage}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} {m['common.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if insightsOpen && selected}
  <!--
    Revisions, SEO and traffic for the page currently open. One panel rather
    than three screens: they are all answers about the same page, and each of
    them had a working endpoint and nothing calling it.
  -->
  <div class="modal modal-open">
    <div class="modal-box max-w-2xl">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold">{m['content.pages.insights.title']()} — {selected.title}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (insightsOpen = false)}><X size={14} /></button>
      </div>

      <div class="tabs tabs-bordered mb-3">
        {#each ([['revisions', m['content.pages.insights.revisions']()],
                 ['seo', m['content.pages.insights.seo']()],
                 ['metrics', m['content.pages.insights.metrics']()],
                 ['variants', m['content.pages.insights.variants']()],
                 ['sitemap', m['content.pages.insights.sitemap']()]] as const) as [key, label] (key)}
          <button class="tab {insightsTab === key ? 'tab-active' : ''}"
            onclick={() => (insightsTab = key)}>{label}</button>
        {/each}
      </div>

      {#if insightsBusy}
        <div class="flex justify-center py-10"><LoaderCircle size={22} class="animate-spin text-primary" /></div>

      {:else if insightsTab === 'revisions'}
        {#if revisions.length === 0}
          <p class="text-sm text-base-content/50 py-6 text-center">{m['content.pages.insights.noRevisions']()}</p>
        {:else}
          <ul class="divide-y divide-base-300 max-h-80 overflow-y-auto">
            {#each revisions as r (r.id)}
              <li class="flex items-center gap-3 py-2">
                <History size={14} class="opacity-40 shrink-0" />
                <span class="text-sm flex-1">{new Date(r.created_at).toLocaleString()}</span>
                <button class="btn btn-ghost btn-xs" onclick={() => restoreRevision(r)}>
                  {m['content.pages.insights.restore']()}
                </button>
              </li>
            {/each}
          </ul>
          <p class="text-[11px] text-base-content/50 mt-2">
            {m['content.pages.insights.restoreHint']()}
          </p>
        {/if}

      {:else if insightsTab === 'seo'}
        {#if seo}
          <div class="flex items-center gap-4 mb-3">
            <div class="radial-progress text-primary" style="--value:{seo.overall_score}; --size:4rem;"
              role="progressbar" aria-valuenow={seo.overall_score}>{seo.overall_score}</div>
            <div class="text-sm">
              <p class="opacity-60">{m['content.pages.insights.analyzed']()}
                {new Date(seo.analyzed_at).toLocaleString()}</p>
            </div>
          </div>
          {#if (typeof seo.issues === 'string' ? JSON.parse(seo.issues) : seo.issues ?? []).length > 0}
            <ul class="text-sm space-y-1">
              {#each (typeof seo.issues === 'string' ? JSON.parse(seo.issues) : seo.issues) as issue, i (i)}
                <li class="flex gap-2"><span class="text-warning">•</span><span>{issue}</span></li>
              {/each}
            </ul>
          {:else}
            <p class="text-sm text-success">{m['content.pages.insights.noIssues']()}</p>
          {/if}
        {:else}
          <p class="text-sm text-base-content/50 py-4 text-center">{m['content.pages.insights.noSeo']()}</p>
        {/if}
        <button class="btn btn-primary btn-sm mt-4" onclick={analyzeSeo}>
          {m['content.pages.insights.analyze']()}
        </button>

      {:else if insightsTab === 'variants'}
        {#if variants.length === 0}
          <p class="text-sm text-base-content/50 py-4 text-center">{m['content.pages.insights.noVariants']()}</p>
        {:else}
          <table class="table table-sm">
            <thead><tr>
              <th>{m['content.pages.field.name']()}</th>
              <th class="text-right">{m['content.pages.insights.share']()}</th>
              <th class="text-right">{m['content.pages.insights.views']()}</th>
              <th class="text-right">{m['content.pages.insights.conversions']()}</th>
              <th></th>
            </tr></thead>
            <tbody>
              {#each variants as v (v.id)}
                <tr>
                  <td>{v.name}</td>
                  <td class="text-right tabular-nums">{v.traffic_pct}%</td>
                  <td class="text-right tabular-nums">{v.views}</td>
                  <td class="text-right tabular-nums">{v.conversions}</td>
                  <td class="text-right">
                    <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteVariant(v)}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
        <div class="flex gap-2 items-end mt-4">
          <label class="form-control gap-1 flex-1">
            <span class="label-text text-xs">{m['content.pages.insights.newVariant']()}</span>
            <input class="input input-sm" bind:value={variantName} placeholder="Shorter hero" />
          </label>
          <button class="btn btn-primary btn-sm" onclick={addVariant} disabled={!variantName.trim()}>
            <Plus size={14} /> {m['common.create']()}
          </button>
        </div>
        <p class="text-[11px] text-base-content/50 mt-2">{m['content.pages.insights.variantHint']()}</p>

      {:else if insightsTab === 'sitemap'}
        <div class="space-y-3">
          <label class="label cursor-pointer justify-start gap-2">
            <input type="checkbox" class="toggle toggle-sm" bind:checked={sitemapCfg.include_in_sitemap} />
            <span class="label-text text-sm">{m['content.pages.insights.inSitemap']()}</span>
          </label>
          <label class="form-control gap-1 max-w-xs">
            <span class="label-text text-xs">{m['content.pages.insights.changeFreq']()}</span>
            <select class="select select-sm" bind:value={sitemapCfg.change_freq}>
              {#each ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'] as f (f)}
                <option value={f}>{f}</option>
              {/each}
            </select>
          </label>
          <label class="form-control gap-1 max-w-xs">
            <span class="label-text text-xs">{m['content.pages.insights.priority']()}</span>
            <input type="number" min="0" max="1" step="0.1" class="input input-sm"
              bind:value={sitemapCfg.priority} />
          </label>
          <p class="text-[11px] text-base-content/50">{m['content.pages.insights.sitemapHint']()}</p>
          <button class="btn btn-primary btn-sm" onclick={saveSitemap}>{m['common.save']()}</button>
        </div>

      {:else}
        {#if metrics.length === 0}
          <p class="text-sm text-base-content/50 py-6 text-center">{m['content.pages.insights.noMetrics']()}</p>
        {:else}
          <div class="overflow-x-auto max-h-80">
            <table class="table table-sm">
              <thead><tr>
                <th>{m['content.pages.insights.date']()}</th>
                <th class="text-right">{m['content.pages.insights.views']()}</th>
                <th class="text-right">{m['content.pages.insights.visitors']()}</th>
              </tr></thead>
              <tbody>
                {#each metrics as row, i (i)}
                  <tr><td>{new Date(row.date).toLocaleDateString()}</td>
                    <td class="text-right tabular-nums">{row.views}</td>
                    <td class="text-right tabular-nums">{row.unique_visitors}</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

{#if showSaveTemplate}
  <div class="modal modal-open">
    <div class="modal-box max-w-sm">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['content.pages.templates.save']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showSaveTemplate = false)}><X size={14} /></button>
      </div>
      <label class="form-control gap-1">
        <span class="label-text text-xs">{m['content.pages.field.name']()}</span>
        <input class="input input-sm" bind:value={templateName} placeholder="Hero + intro" />
      </label>
      <p class="text-[11px] text-base-content/50 mt-2">{m['content.pages.templates.saveHint']()}</p>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showSaveTemplate = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !templateName.trim()} onclick={saveTemplate}>
          {m['common.save']()}
        </button>
      </div>
    </div>
  </div>
{/if}

<ConfirmModal open={confirmState.open} title={confirmState.title} message={confirmState.message}
  confirmLabel={confirmState.confirmLabel} confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction} oncancel={cancelConfirm} />
