# Official Extension Catalog

The 52 first-party extensions, maintained in the sibling repository
`zveltio-extensions`. 51 ship engine code; `content/pdf-viewer` is Studio-only.
24 categories.

The rows are copied from the manifests by `bun run sync-catalog`, which also
refreshes the engine's bundled `catalog.json`; it runs when a release is cut.
Adding or removing a row is done by hand. To count the extensions, read
`manifest.json` under every directory in that repository — with
`find . -name manifest.json -not -path '*/node_modules/*'` and **no depth
limit**. The tree is uneven in both directions: five extensions sit at the top
level (`ai`, `billing`, `crm`, `forms`, `sms`), most at
`category/name/`, and five sit a level deeper under `compliance/ro/`. A
`*/*/manifest.json` glob misses the shallow five; `-maxdepth 3` misses the deep
five. Both mistakes have been made and written into documents as corrections to
accurate counts.

---

## intelligence

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `ai` | AI | 2.1.0 | AI chat on providers the operator allows: OpenAI, Anthropic, Ollama or any OpenAI-compatible server, with prompt templates and a usage log. The assistant acts as its caller and nothing more. |

## analytics

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `analytics/dashboard` | Dashboards | 2.0.1 | Role-aware, per-user home dashboards — IT sets a default layout per role, each user personalizes within their permissions |
| `analytics/quality` | Data Quality | 2.0.1 | Data quality scans over the data API, as the scanning user: duplicates, missing values, outliers and optional AI normalization hints |

## auth

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `auth/ldap` | LDAP / Active Directory | 3.0.1 | Authenticate users via LDAP or Active Directory (ldapts) |
| `auth/saml` | SAML 2.0 SSO | 2.2.1 | SAML 2.0 Single Sign-On with external Identity Providers (Okta, Azure AD, Google Workspace) |
| `auth/scim` | SCIM Provisioning | 3.0.0 | SCIM 2.0 user provisioning for Azure AD / Entra, Okta and other identity providers — engine API keys, Users CRUD, active-flag offboarding |

## billing

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `billing` | Billing & Usage | 2.3.0 | Usage metering and Stripe billing integration |

## business

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `crm` | CRM | 2.1.0 | Contacts, Organizations, and Transactions — owned by this extension, not the engine core |

## communications

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `communications/mail` | Mail Client | 2.2.0 | IMAP/SMTP mail client: accounts, folders, messages, drafts, identities, signatures, filters and contacts as collections; syncing and sending run as jobs that reach only the mail servers an operator binds to the "mail" slot. |

## compliance

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `compliance/gdpr` | GDPR Compliance | 3.0.0 | Data export and right to erasure (GDPR Art. 15, 17) |

## compliance/ro — Romanian regulatory

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `compliance/ro/documents` | RO Documents | 2.1.0 | Romanian compliance document management — contracts, PVs, NIRs, dispozitii de plata |
| `compliance/ro/efactura` | e-Factura RO | 2.1.0 | Romanian e-Invoice (e-Factura): build the UBL XML (CIUS-RO), submit it to ANAF, follow its state and keep ANAF's signed answer |
| `compliance/ro/etransport` | e-Transport RO | 2.1.0 | Romanian e-Transport monitoring system — declare and track road transport of goods via ANAF |
| `compliance/ro/procurement` | Achizitii Publice RO | 2.3.0 | Romanian public procurement management — purchase orders, supplier registry, budget tracking |
| `compliance/ro/saft` | SAF-T RO | 2.0.0 | Romanian SAF-T (D406) — build the audit file XML from the finance/accounting ledger |

## content

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `content/pages` | Pages | 2.3.0 | Pages built from blocks, grouped into sites. Authors edit drafts; publishing writes the sanitized snapshot a public website or a signed-in portal renders, read through the data API under the engine's rules. |
| `content/media` | Media Library | 2.1.0 | Tags, favorites, curated collections and AI metadata for the engine’s media files |
| `content/documents` | Document Generator | 2.0.1 | Numbered documents generated from templates as the caller, with signatures by logged-in users |
| `content/document-templates` | Document Templates | 2.1.0 | HTML templates with {{variable}} interpolation, rendered to PDF as the caller |
| `content/drafts` | Content Drafts | 2.1.1 | Draft, review and publish workflow for content collections, through the data API as the publishing user |
| `content/pdf-viewer` | PDF Viewer | 1.0.1 | Inline PDF viewer components for client apps and integrator-built pages. Exports PdfViewer and PdfBlock; no page-builder block type is registered. |

## data

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `data/export` | Data Export | 2.0.1 | Export collection data as JSON, CSV or NDJSON through the data API, as the exporting user |
| `data/import` | Data Import | 2.0.2 | Import collection data from CSV, JSON or NDJSON files through the data API, as the importing user |

## developer

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `developer/api-docs` | API Documentation | 2.2.0 | Swagger UI over the data API: each visitor sees the collections they may read |
| `developer/byod` | BYOD Import | 2.0.1 | External database schema introspection and import |
| `developer/graphql` | GraphQL API | 2.2.0 | Auto-generated GraphQL API with playground for all collections |

## ecommerce

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `ecommerce/store` | eCommerce | 2.1.0 | Product catalog, orders, coupons, shipping, carts and reviews, with checkout and moderation as actions |

## finance

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `finance/invoicing` | Invoicing | 2.6.0 | Recurring invoices, payment tracking and overdue management |
| `finance/accounting` | Accounting | 2.2.0 | Double-entry bookkeeping: chart of accounts, journal entries, fiscal years, budgets, trial balance, P&L and balance sheet |
| `finance/banking` | Banking Sync | 2.2.0 | Import bank statements, auto-reconcile transactions with invoices and track cash flow |
| `finance/subscriptions` | Subscriptions | 2.3.0 | Recurring billing plans, subscribers, metered usage, invoices and dunning |
| `finance/expenses` | Expenses | 2.3.0 | Employee expense reports with receipt management, categorization and approval flow |
| `finance/quotes` | Quotes & Proposals | 2.2.0 | Quotes and proposals linked to CRM contacts, converted into invoices |

## forms

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `forms` | Form Builder | 3.0.0 | Forms, checklists and inspections: public one-shot forms and responses attached to records, filled field by field, with completion, scoring and recurrence |

## geospatial

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `geospatial/postgis` | PostGIS | 2.3.0 | Location history and map components — proximity and bounding-box search through the data API |

## hr

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `hr/payroll` | Payroll RO | 2.0.0 | Romanian payroll: CAS, CASS, income tax calculations, meal vouchers and Revisal XML export |
| `hr/employees` | HR | 2.1.0 | Employee records, departments, job positions, contracts and onboarding checklists |
| `hr/leave` | Leave Management | 2.1.0 | Vacation and leave requests with balance tracking and an approval workflow |
| `hr/time-tracking` | Time Tracking | 2.3.0 | Timesheets, project-based time logging and billable hours |

## i18n

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `i18n/translations` | Translations | 2.1.0 | Internationalization: locales, translation keys, per-locale values, a glossary and approvals |

## integrations

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `integrations/api-connector` | API Connector | 2.2.0 | No-code HTTP integrations: call external REST APIs on hosts the operator allows, with retries, OAuth2 and a call log; receive signed incoming webhooks |
| `integrations/migrators` | Data Migrators | 2.0.1 | Import your data from HubSpot, Notion and Airtable into Zveltio collections, through the data API as the importing user |

## operations

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `operations/traceability` | Trasabilitate Alimentară | 2.0.1 | Trasabilitate alimentară conformă Reg. CE 178/2002 (Art. 18) și cerințelor ANSVSA România — recepție loturi, scanare QR, arbore bidirecțional, simulator recall. |
| `operations/inventory` | Inventory | 2.2.0 | Warehouses, SKUs, stock movements, reorder alerts and barcode support |
| `operations/pos` | Point of Sale | 2.2.0 | Till sessions, sales, receipts numbering, loyalty, cash movements and Z-reports, with stock moved through inventory |
| `operations/assets` | Fixed Assets | 2.2.0 | Fixed asset register, straight-line and declining balance depreciation posted to the ledger, maintenance, insurance, revaluations and transfers |

## projects

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `projects/helpdesk` | Helpdesk | 2.1.0 | Support ticket management with SLA timers, priorities, assignments and message threads |
| `projects/management` | Project Management | 2.1.0 | Projects, milestones, tasks, kanban board, team assignments and progress tracking |

## sms

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `sms` | SMS / Push Notifications | 2.2.0 | Send SMS through Twilio or Vonage, with templates and delivery reports |

## storage

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `storage/cloud` | Cloud Storage | 2.0.0 | Version history, favorites and retention policies over the engine's stored files |

## workflow

| Extension | Name | Ver | What it does |
|---|---|---|---|
| `workflow/approvals` | Approval Workflows | 2.1.0 | Multi-step approval workflows for any collection |
| `workflow/checklists` | Checklists | 2.1.0 | Deprecated: use forms 3.0.0, which attaches checklists to records. Attach reusable checklists to any collection record |

---

## What is *not* an extension

These live in the engine core, and a document claiming otherwise is out of date:
**flows** (automation), **backup**, **insights**, **saved queries**, **schema
branches**, **tenants**, **collections**, **storage**, **webhooks**,
**realtime**, **audit**, **notifications**.

Some capabilities moved the other way and their old core routes now return
**410 Gone** with a forwarding address: approvals → `workflow/approvals`,
export → `data/export`, import → `data/import`, media → `content/media`,
briefing → `crm`. Edge function administration went back to the engine
(`/api/edge-functions`, Studio **Developer → Edge Functions**) and the
`developer/edge-functions` extension was retired.

`developer/views` and `content/page-builder` were **merged into
`content/pages`** and no longer exist.
