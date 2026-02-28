export interface ExtensionCatalogEntry {
  name: string;
  displayName: string;
  description: string;
  category: string;
  version: string;
  author: string;
  tags: string[];
  bundled: boolean;
  permissions: string[];
}

export const EXTENSION_CATALOG: ExtensionCatalogEntry[] = [
  {
    name: 'workflow/approvals',
    displayName: 'Approvals',
    description:
      'Multi-step approval workflows with email notifications, SLA tracking, and full audit trail.',
    category: 'workflow',
    version: '1.0.0',
    author: 'Zveltio',
    tags: ['workflow', 'approvals', 'notifications'],
    bundled: true,
    permissions: ['database', 'email'],
  },
  {
    name: 'workflow/checklists',
    displayName: 'Checklists',
    description:
      'Dynamic checklists and forms with scoring, conditional logic, and response analytics.',
    category: 'workflow',
    version: '1.0.0',
    author: 'Zveltio',
    tags: ['forms', 'checklists', 'scoring'],
    bundled: true,
    permissions: ['database'],
  },
  {
    name: 'ai/core-ai',
    displayName: 'Core AI',
    description:
      'AI chat, embeddings, semantic search, and multi-provider management (OpenAI, Anthropic, Mistral, local).',
    category: 'ai',
    version: '1.0.0',
    author: 'Zveltio',
    tags: ['ai', 'chat', 'embeddings', 'search'],
    bundled: true,
    permissions: ['database', 'external-api'],
  },
  {
    name: 'content/page-builder',
    displayName: 'Page Builder',
    description:
      'Visual CMS page builder with drag-and-drop sections, blocks, SEO fields, and live preview.',
    category: 'content',
    version: '1.0.0',
    author: 'Zveltio',
    tags: ['cms', 'pages', 'content'],
    bundled: true,
    permissions: ['database', 'storage'],
  },
  {
    name: 'automation/flows',
    displayName: 'Flows',
    description:
      'Visual automation builder: triggers (event, schedule, webhook), conditions, actions, and run history.',
    category: 'automation',
    version: '1.0.0',
    author: 'Zveltio',
    tags: ['automation', 'flows', 'triggers'],
    bundled: true,
    permissions: ['database', 'webhooks'],
  },
  {
    name: 'developer/edge-functions',
    displayName: 'Edge Functions',
    description:
      'Write and deploy TypeScript serverless functions directly inside the engine with a sandboxed runtime.',
    category: 'developer',
    version: '1.0.0',
    author: 'Zveltio',
    tags: ['functions', 'serverless', 'typescript'],
    bundled: true,
    permissions: ['database'],
  },
  {
    name: 'geospatial/postgis',
    displayName: 'Geospatial',
    description:
      'Location field type, map views in Studio, proximity search, bbox queries, clustering, and geofences.',
    category: 'geospatial',
    version: '1.0.0',
    author: 'Zveltio',
    tags: ['maps', 'location', 'geospatial', 'postgis'],
    bundled: true,
    permissions: ['database'],
  },
  {
    name: 'compliance/ro/efactura',
    displayName: 'e-Factura RO',
    description:
      'UBL 2.1 XML invoice generator with ANAF submission and status tracking for Romanian e-invoicing.',
    category: 'compliance',
    version: '1.0.0',
    author: 'Zveltio',
    tags: ['invoicing', 'anaf', 'romania', 'ubl'],
    bundled: true,
    permissions: ['database', 'external-api'],
  },
  {
    name: 'compliance/ro/documents',
    displayName: 'Documents RO',
    description:
      'Romanian business document generation: contracts, PV, NIR, and payment orders.',
    category: 'compliance',
    version: '1.0.0',
    author: 'Zveltio',
    tags: ['documents', 'contracts', 'romania'],
    bundled: true,
    permissions: ['database', 'storage'],
  },
  {
    name: 'compliance/ro/procurement',
    displayName: 'Procurement RO',
    description:
      'Purchase orders, supplier registry, and budget execution for Romanian procurement workflows.',
    category: 'compliance',
    version: '1.0.0',
    author: 'Zveltio',
    tags: ['procurement', 'suppliers', 'budget', 'romania'],
    bundled: true,
    permissions: ['database'],
  },
];
