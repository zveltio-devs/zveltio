# Official Extension Catalog

The 56 first-party extensions, maintained in the sibling repository
`zveltio-extensions`. 55 ship engine code; `content/pdf-viewer` is Studio-only.
24 categories.

**Generated from the manifests on 2026-09-02.** To regenerate, read
`manifest.json` under every directory in that repository — counting with
`find . -name manifest.json -not -path '*/node_modules/*'` and **no depth
limit**. The tree is uneven in both directions: six extensions sit at the top
level (`ai`, `billing`, `crm`, `forms`, `search`, `sms`), most at
`category/name/`, and five sit a level deeper under `compliance/ro/`. A
`*/*/manifest.json` glob misses the shallow six; `-maxdepth 3` misses the deep
five. Both mistakes have been made and written into documents as corrections to
accurate counts.

---

## intelligence

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `ai` | AI | 1.0.11 | Providers, chat, embeddings, semantic search, text-to-SQL, schema generation, agentic workflows |

## analytics

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `analytics/dashboard` | Dashboards | 1.0.2 | Role-aware per-user home dashboards; IT sets a default layout per role, users personalise within their permissions |
| `analytics/quality` | Data Quality | 1.0.2 | Automated quality scans, anomaly detection, issue management |

## auth

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `auth/ldap` | LDAP / Active Directory | 1.1.2 | Authenticate against LDAP or AD (ldapts) |
| `auth/saml` | SAML 2.0 SSO | 1.0.3 | SSO with Okta, Azure AD, Google Workspace |
| `auth/scim` | SCIM Provisioning | 1.0.6 | SCIM 2.0 provisioning — bearer tokens, Users CRUD, active-flag offboarding |

## billing

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `billing` | Billing & Usage | 1.0.6 | Usage metering and Stripe billing |

## business

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `crm` | CRM | 1.0.5 | Contacts, organisations, transactions — owned by the extension, not the core |

## communications

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `communications/mail` | Mail Client | 1.0.18 | IMAP/SMTP client with AI features, filter rules, attachments, contacts; password or OAuth2 (Gmail/Outlook); scheduled background sync |

## compliance

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `compliance/gdpr` | GDPR Compliance | 1.0.2 | Data export and right to erasure (GDPR Art. 15, 17) |

## compliance/ro — Romanian regulatory

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `compliance/ro/documents` | RO Documents | 1.0.3 | Contracts, PVs, NIRs, dispoziții de plată |
| `compliance/ro/efactura` | e-Factura RO | 1.0.5 | ANAF e-invoicing — generate, validate and submit UBL XML |
| `compliance/ro/etransport` | e-Transport RO | 1.0.1 | Declare and track road transport of goods via ANAF |
| `compliance/ro/procurement` | Achiziții Publice RO | 1.0.2 | Public procurement — purchase orders, supplier registry, budget tracking |
| `compliance/ro/saft` | SAF-T RO | 1.0.1 | Standard Audit File for Tax (D.394) XML for ANAF |

## content

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `content/pages` | Pages | 1.0.5 | Pages built from blocks — content or live collection data — grouped into sites. A site is a public website with SEO and sitemap, or an authenticated portal with its own branding, base path and access roles |
| `content/media` | Media Library | 1.0.5 | Folders, files, tags |
| `content/documents` | Document Generator | 1.0.3 | PDFs from templates with data binding |
| `content/document-templates` | Document Templates | 1.0.3 | Admin-managed HTML/PDF templates, variable interpolation, async generation |
| `content/drafts` | Content Drafts | 1.0.2 | Draft/publish workflow for content collections |
| `content/pdf-viewer` | PDF Viewer | 1.0.0 | Inline PDF viewer for the asset manager, client apps and page blocks. **Studio-only — no engine code** |

## data

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `data/export` | Data Export | 1.0.3 | JSON, CSV, NDJSON with filtering |
| `data/import` | Data Import | 1.0.4 | CSV/JSON import with column mapping and background processing |

## developer

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `developer/api-docs` | API Documentation | 1.0.2 | Swagger UI + OpenAPI generated from collections |
| `developer/byod` | BYOD Import | 1.0.4 | Introspect and import an external database schema |
| `developer/database` | Database Management | 1.0.4 | Functions, triggers, enums, roles, RLS |
| `developer/edge-functions` | Edge Functions | 1.0.4 | Serverless functions running inside the engine |
| `developer/graphql` | GraphQL API | 1.0.2 | Auto-generated GraphQL with playground |
| `developer/validation` | Data Validation | 1.0.3 | Field-level rules with AI-assisted natural-language authoring |

## ecommerce

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `ecommerce/store` | eCommerce | 1.0.7 | Catalog, orders, customers, coupons, public storefront API |

## finance

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `finance/invoicing` | Invoicing | 1.0.11 | Recurring invoices, payment tracking, overdue management |
| `finance/accounting` | Accounting | 1.0.8 | Double-entry bookkeeping, chart of accounts, journals, P&L, balance sheet |
| `finance/banking` | Banking Sync | 1.0.8 | Statement import, auto-reconciliation, cash flow |
| `finance/subscriptions` | Subscriptions | 1.0.7 | Recurring plans, subscribers, MRR/ARR, Stripe |
| `finance/expenses` | Expenses | 1.0.5 | Expense reports with receipts, categorisation, approval |
| `finance/quotes` | Quotes & Proposals | 1.0.5 | Branded PDF quotes linked to CRM, convert-to-invoice |

## forms

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `forms` | Form Builder | 1.0.7 | Drag-and-drop builder with public submission endpoints |

## geospatial

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `geospatial/postgis` | PostGIS | 1.0.4 | Proximity search, bounding box, polygon containment |

## hr

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `hr/payroll` | Payroll RO | 1.1.8 | Romanian payroll — CAS, CASS, income tax, meal vouchers, Revisal XML export |
| `hr/employees` | HR | 1.1.5 | Employee records, departments, positions, contracts, onboarding checklists |
| `hr/leave` | Leave Management | 1.0.6 | Requests, balances, approvals, calendar |
| `hr/time-tracking` | Time Tracking | 1.0.6 | Timesheets, project time, billable hours, client reports |

## i18n

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `i18n/translations` | Translations | 1.0.5 | Locales, translation keys, per-locale values |

## integrations

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `integrations/api-connector` | API Connector | 1.0.6 | No-code REST integrations — field mapping, retries, execution logs |
| `integrations/migrators` | Data Migrators | 1.0.2 | Import from HubSpot, Notion, Airtable — encrypted connections, mapping preview, audited runs |

## operations

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `operations/traceability` | Trasabilitate Alimentară | 1.2.2 | Food traceability per Reg. CE 178/2002 Art. 18 and ANSVSA — lot reception, QR scanning, bidirectional tree, recall simulator |
| `operations/inventory` | Inventory | 1.0.8 | Warehouses, SKUs, stock movements, reorder alerts, barcodes |
| `operations/pos` | Point of Sale | 1.0.7 | Cash register, receipts, end-of-day reports, inventory integration |
| `operations/assets` | Fixed Assets | 1.0.6 | Asset register, straight-line and declining depreciation, maintenance |

## projects

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `projects/helpdesk` | Helpdesk | 1.0.4 | Tickets with SLA timers, priorities, assignment, message threads |
| `projects/management` | Project Management | 1.0.3 | Projects, milestones, tasks, kanban, assignments, progress |

## search

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `search` | Search Adapter | 1.0.3 | Full-text search via MeiliSearch or Typesense with automatic record sync |

## sms

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `sms` | SMS / Push Notifications | 1.0.3 | Twilio or Vonage, templates, delivery tracking |

## storage

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `storage/cloud` | Cloud Storage | 1.0.5 | Versioning, trash, public share links, quotas |

## workflow

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `workflow/approvals` | Approval Workflows | 1.0.4 | Multi-step approvals for any collection |
| `workflow/checklists` | Checklists | 1.0.4 | Reusable checklists attached to any record |

---

## What is *not* an extension

These live in the engine core, and a document claiming otherwise is out of date:
**flows** (automation), **backup**, **insights**, **saved queries**, **schema
branches**, **tenants**, **collections**, **storage**, **webhooks**,
**realtime**, **audit**, **notifications**.

Some capabilities moved the other way and their old core routes now return
**410 Gone** with a forwarding address: approvals → `workflow/approvals`,
export → `data/export`, import → `data/import`, media → `content/media`,
edge functions → `developer/edge-functions`, briefing → `crm`.

`developer/views` and `content/page-builder` were **merged into
`content/pages`** and no longer exist.

---

## Known gaps in this catalog

Verified 2026-09-02 — see [../platform/known-gaps.md](../platform/known-gaps.md)
for the full list:

- `crm` ships five pipeline tables with no routes.
- `forms` advertises a `file` field type it cannot accept.
- `hr/time-tracking` numbers invoices with `COUNT(*) + 1`.
- `auth/scim` answers `/Groups` with an empty list rather than 501.
- `projects/helpdesk` Studio and API disagree on field names.
