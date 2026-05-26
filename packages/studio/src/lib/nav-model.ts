/**
 * Nav model — the source of truth for the admin sidebar's grouped items.
 * Labels are Paraglide keys resolved at render time in Sidebar / MobileSidebar.
 */
import { base } from '$app/paths';
import {
  LayoutDashboard,
  Database,
  Users,
  Shield,
  Webhook,
  Settings,
  Puzzle,
  HardDrive,
  Key,
  ClipboardList,
  Languages,
  Upload,
  Bell,
  Download,
  Workflow,
  Package,
  GitBranch,
  Plug,
  Building2,
  Images,
  DatabaseBackup,
  Layout,
  CheckSquare,
  ScanSearch,
  Code,
  Bookmark,
  BarChart2,
  Terminal,
  Activity,
  LayoutGrid,
  Zap,
  Sparkles,
} from '@lucide/svelte';
import type { Component } from 'svelte';

/** Paraglide message key under `nav.*` or `nav.group.*`. */
export type NavLabelKey = string;

/** Core Studio route — label via Paraglide `labelKey`. */
export type CoreNavItem = { href: string; icon: Component; labelKey: NavLabelKey; ext?: string };
/** Extension route — label from manifest (product name). */
export type ExtensionNavItem = { href: string; icon: Component; label: string };
export type NavGroup = { labelKey?: NavLabelKey; items: CoreNavItem[] };

export const EXT_NAV_GROUP_ORDER = [
  'business',
  'finance',
  'hr',
  'operations',
  'compliance',
  'content',
  'communications',
  'projects',
  'developer',
  'other',
] as const;

export type ExtensionNavGroupId = (typeof EXT_NAV_GROUP_ORDER)[number];

export type ExtensionNavGroup = { id: ExtensionNavGroupId; items: ExtensionNavItem[] };

export type ExtensionMeta = {
  name: string;
  displayName?: string;
  description?: string;
  category?: string;
  contributes?: { engine?: boolean; studio?: boolean; client?: boolean };
  studio?: {
    navGroup?: string;
    pages?: Array<{ path: string; label: string; icon?: string }>;
  };
};

interface ExtensionState {
  initialized: boolean;
  meta: ExtensionMeta[];
  isActive(name: string): boolean;
}

const RAW_NAV: NavGroup[] = [
  {
    items: [
      { href: `${base}/`, icon: LayoutDashboard, labelKey: 'nav.dashboard' },
      { href: `${base}/onboarding`, icon: Zap, labelKey: 'nav.quickSetup' },
    ],
  },
  {
    labelKey: 'nav.group.build',
    items: [
      { href: `${base}/collections`, icon: Database, labelKey: 'nav.collections' },
      { href: `${base}/templates`, icon: Sparkles, labelKey: 'nav.templates' },
      { href: `${base}/views`, icon: Layout, labelKey: 'nav.views' },
      { href: `${base}/zones`, icon: LayoutGrid, labelKey: 'nav.zones' },
      { href: `${base}/media`, icon: Images, labelKey: 'nav.media', ext: 'content/media' },
    ],
  },
  {
    labelKey: 'nav.group.security',
    items: [
      { href: `${base}/users`, icon: Users, labelKey: 'nav.users' },
      { href: `${base}/permissions`, icon: Shield, labelKey: 'nav.permissions' },
      { href: `${base}/rls`, icon: Shield, labelKey: 'nav.rowSecurity' },
      { href: `${base}/column-permissions`, icon: Shield, labelKey: 'nav.columnSecurity' },
      { href: `${base}/api-keys`, icon: Key, labelKey: 'nav.apiKeys' },
      { href: `${base}/tenants`, icon: Building2, labelKey: 'nav.tenants' },
    ],
  },
  {
    labelKey: 'nav.group.workflows',
    items: [
      { href: `${base}/flows`, icon: Workflow, labelKey: 'nav.flows' },
      { href: `${base}/webhooks`, icon: Webhook, labelKey: 'nav.webhooks' },
      { href: `${base}/notifications`, icon: Bell, labelKey: 'nav.notifications' },
      { href: `${base}/approvals`, icon: CheckSquare, labelKey: 'nav.approvals' },
    ],
  },
  {
    labelKey: 'nav.group.insights',
    items: [
      { href: `${base}/insights`, icon: BarChart2, labelKey: 'nav.analytics' },
      { href: `${base}/audit`, icon: ClipboardList, labelKey: 'nav.auditLog' },
      { href: `${base}/request-logs`, icon: Activity, labelKey: 'nav.requestLogs' },
    ],
  },
  {
    labelKey: 'nav.group.developer',
    items: [
      { href: `${base}/edge-functions`, icon: Code, labelKey: 'nav.edgeFunctions' },
      { href: `${base}/rpc`, icon: Zap, labelKey: 'nav.rpcFunctions' },
      { href: `${base}/schema-branches`, icon: GitBranch, labelKey: 'nav.schemaBranches' },
      { href: `${base}/virtual-collections`, icon: Plug, labelKey: 'nav.virtualCollections' },
      { href: `${base}/saved-queries`, icon: Bookmark, labelKey: 'nav.savedQueries' },
      { href: `${base}/sql`, icon: Terminal, labelKey: 'nav.sqlEditor' },
      {
        href: `${base}/introspect`,
        icon: ScanSearch,
        labelKey: 'nav.byodImport',
        ext: 'developer/byod',
      },
    ],
  },
  {
    labelKey: 'nav.group.system',
    items: [
      { href: `${base}/storage`, icon: HardDrive, labelKey: 'nav.storage' },
      { href: `${base}/backup`, icon: DatabaseBackup, labelKey: 'nav.backup' },
      { href: `${base}/import`, icon: Upload, labelKey: 'nav.import', ext: 'data/import' },
      { href: `${base}/export`, icon: Download, labelKey: 'nav.export', ext: 'data/export' },
      {
        href: `${base}/translations`,
        icon: Languages,
        labelKey: 'nav.translations',
        ext: 'i18n/translations',
      },
      { href: `${base}/marketplace`, icon: Package, labelKey: 'nav.marketplace' },
      { href: `${base}/settings`, icon: Settings, labelKey: 'nav.settings' },
    ],
  },
];

const RAW_NAV_EXT_NAMES: Set<string> = new Set(
  RAW_NAV.flatMap((g) => g.items)
    .filter((i) => i.ext)
    .map((i) => i.ext!),
);

const CATEGORY_TO_GROUP: Record<string, ExtensionNavGroupId> = {
  business: 'business',
  finance: 'finance',
  hr: 'hr',
  operations: 'operations',
  compliance: 'compliance',
  content: 'content',
  communications: 'communications',
  projects: 'projects',
  developer: 'developer',
  analytics: 'developer',
  auth: 'other',
  geospatial: 'developer',
  integrations: 'developer',
  workflow: 'other',
  billing: 'finance',
  ecommerce: 'business',
  data: 'developer',
  storage: 'other',
  search: 'developer',
  sms: 'communications',
  ai: 'developer',
  forms: 'content',
  i18n: 'other',
};

function resolveExtensionNavGroup(meta: ExtensionMeta): ExtensionNavGroupId {
  const explicit = meta.studio?.navGroup;
  if (explicit && (EXT_NAV_GROUP_ORDER as readonly string[]).includes(explicit)) {
    return explicit as ExtensionNavGroupId;
  }
  const cat = meta.category?.toLowerCase();
  if (cat && CATEGORY_TO_GROUP[cat]) return CATEGORY_TO_GROUP[cat];
  const prefix = meta.name.split('/')[0]?.toLowerCase();
  if (prefix && CATEGORY_TO_GROUP[prefix]) return CATEGORY_TO_GROUP[prefix];
  return 'other';
}

function metaToNavItem(meta: ExtensionMeta): ExtensionNavItem {
  const firstPage = meta.studio?.pages?.[0];
  const slug = firstPage?.path
    ? firstPage.path.replace(/^\/admin\//, '').replace(/^\//, '')
    : meta.name;
  return {
    href: `${base}/${slug}`,
    icon: Puzzle,
    label: firstPage?.label || meta.displayName || meta.name,
  };
}

export function buildNavModel(extensions: ExtensionState): NavGroup[] {
  return RAW_NAV.map((g) => ({
    ...g,
    items: g.items.filter((it) => !it.ext || extensions.isActive(it.ext)),
  })).filter((g) => g.items.length > 0);
}

export function buildExtensionNavGroups(extensions: ExtensionState): ExtensionNavGroup[] {
  if (!extensions.initialized) return [];

  const buckets = new Map<ExtensionNavGroupId, ExtensionNavItem[]>();
  for (const id of EXT_NAV_GROUP_ORDER) buckets.set(id, []);

  for (const m of extensions.meta) {
    if (!extensions.isActive(m.name)) continue;
    if (RAW_NAV_EXT_NAMES.has(m.name)) continue;
    if (!((m.studio?.pages && m.studio.pages.length > 0) || m.contributes?.studio)) continue;
    const groupId = resolveExtensionNavGroup(m);
    buckets.get(groupId)!.push(metaToNavItem(m));
  }

  return EXT_NAV_GROUP_ORDER.map((id) => ({ id, items: buckets.get(id)! })).filter(
    (g) => g.items.length > 0,
  );
}

/** Flat extension nav (manifest labels). */
export function buildExtensionNav(extensions: ExtensionState): ExtensionNavItem[] {
  return buildExtensionNavGroups(extensions).flatMap((g) => g.items);
}

/** Cmd+K palette row — labels resolved by caller (Paraglide / manifest). */
export type PaletteNavItem = {
  label: string;
  href: string;
  icon: Component;
  group: string;
  sub?: string;
};

export function buildPaletteNavItems(
  extensions: ExtensionState,
  resolveCoreLabel: (key: NavLabelKey) => string,
  resolveExtGroupLabel: (id: ExtensionNavGroupId) => string,
  navigationGroupLabel: string,
): PaletteNavItem[] {
  const out: PaletteNavItem[] = [];
  for (const g of buildNavModel(extensions)) {
    const group = g.labelKey ? resolveCoreLabel(g.labelKey) : navigationGroupLabel;
    for (const it of g.items) {
      out.push({
        label: resolveCoreLabel(it.labelKey),
        href: it.href,
        icon: it.icon,
        group,
      });
    }
  }
  for (const g of buildExtensionNavGroups(extensions)) {
    const group = resolveExtGroupLabel(g.id);
    for (const it of g.items) {
      out.push({ label: it.label, href: it.href, icon: it.icon, group });
    }
  }
  return out;
}
