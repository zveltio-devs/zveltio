# Zveltio — Technical Gaps & Roadmap to Production Maturity

> Honest inventory of what's missing or weak. Written after the wave 39-40
> alpha.82 release. Audience: contributors, maintainers, and serious
> evaluators who want to know what they're getting into before betting on
> Zveltio.
>
> **Status legend**
> - 🔴 **P0** — blocker for serious adoption; should be done before v1.0
> - 🟠 **P1** — high impact; v1.0 polish or post-v1.0 priority 1
> - 🟡 **P2** — meaningful improvement; nice-to-have for v1.0
> - 🟢 **P3** — long-term differentiation; post-v1.0 strategic

---

## Table of contents

1. [Reliability & Operations](#1-reliability--operations)
2. [Security & Compliance](#2-security--compliance)
3. [Performance & Scale](#3-performance--scale)
4. [Developer Experience](#4-developer-experience)
5. [Manager-Facing Capabilities](#5-manager-facing-capabilities)
6. [Internationalization](#6-internationalization)
7. [Ecosystem & Community](#7-ecosystem--community)
8. [Long-term Differentiation](#8-long-term-differentiation)
9. [Cross-cutting verification](#9-cross-cutting-verification)

---

## 1. Reliability & Operations

### 1.1 Performance benchmarks — measured, not claimed 🟠 P1 (mostly shipped)
**Done.** Benchmark suite at `bench/benchmarks/` (rest-crud, list-pagination,
realtime, cold-start) + `docs/BENCHMARKS.md` with measured p50/p95/p99 numbers,
run in CI via the `perf-smoke` job (see 3.1).

**Remaining (downgraded from P0).**
- Comparison runs vs Pocketbase / Supabase / PostgREST on identical hardware.
- Public per-release dashboard (`bench.zveltio.com`) beyond the in-repo doc.
- Query-builder vs raw-SQL + memory-baseline coverage.

**Effort.** 3-4 days.
**Dependencies.** None.

---

### 1.2 Disaster recovery procedures — documented and tested 🔴 P0
**Gap.** `backup` extension exists (PITR + scheduled), Proxmox + PBS hooks exist (`zveltio-get/pbs-hooks/`). But we don't document RPO/RTO targets, tested restore procedures, or failure modes.

**Why it matters.** Operators won't trust the platform without DR runbooks. Compliance audits require documented recovery procedures.

**Acceptance criteria.**
- `docs/DISASTER-RECOVERY.md` covering: backup taxonomy (logical vs PITR vs filesystem snapshots), restore drill procedure (step-by-step), RPO/RTO commitments per backup tier.
- Automated DR drill script (`scripts/dr-drill.sh`) that:
  1. Spins up a fresh Postgres
  2. Restores from latest backup
  3. Verifies record counts, schema integrity, audit trail continuity
  4. Reports drift / data loss
- Run in CI weekly as a scheduled job.
- Proxmox-specific: document PBS verify-job + retention policies.

**Effort.** 1 week.
**Dependencies.** None.

---

### 1.3 Observability dashboards — Grafana templates 🟠 P1
**Gap.** OpenTelemetry tracing emits to OTLP collector. Prometheus metrics exposed at `/metrics`. But there's no out-of-the-box Grafana dashboard — operators are on their own to build.

**Why it matters.** "It exposes metrics" vs "open Grafana and see your engine" is the difference between "works" and "production-ready".

**Acceptance criteria.**
- `grafana/dashboards/` directory in repo with JSON definitions:
  - **Engine Overview** — request rate, error rate, p50/p95/p99 latency, active connections, DB pool health
  - **Database** — query rate, slow queries, cache hit ratio, replication lag, locks
  - **DDL Queue** — job stats (pg-boss), retries, DLQ depth, oldest pending job
  - **Realtime** — subscription count, message throughput, broker latency
  - **Extensions** — per-extension request counts, error rates, route latency
  - **AI** — token usage per provider, cost estimate, semantic search query rate
- `docker-compose.observability.yml` overlay that starts Grafana + Loki + Tempo with dashboards provisioned.
- Operator docs: how to wire to existing observability stack.

**Effort.** 1-2 weeks.
**Dependencies.** OTel + Prometheus exporters validated (mostly there).

---

### 1.4 Production health checks — beyond `/api/health` 🟠 P1
**Gap.** Current `/api/health` returns DB connectivity OK/degraded. No deep health checks: extension load status, queue worker liveness, file storage reachability, Valkey connectivity, embedding provider status.

**Why it matters.** Kubernetes / Proxmox / load balancer integration needs deep health endpoints. Surface-level health = false confidence.

**Acceptance criteria.**
- `GET /api/health/deep` — checks every subsystem, returns 200 only if ALL healthy.
- `GET /api/health/<subsystem>` — DB, queue, storage, cache, realtime, extensions.
- Per-extension health hook (`onHealthCheck` in `ExtensionContext`).
- Documented in OpenAPI spec.
- Helm chart updated with proper liveness/readiness probes.

**Effort.** 3-5 days.
**Dependencies.** None.

---

### 1.5 Graceful degradation modes 🟠 P1
**Gap.** What happens when Valkey is down? When AI provider returns 500? When external file storage is unreachable? Current behavior: errors bubble up. Should: degrade gracefully (in-memory cache fallback, queue locally, etc.).

**Why it matters.** Real production has flaky dependencies. Manager wants "the app keeps working when Valkey blips".

**Acceptance criteria.**
- Cache: fallback to in-memory LRU when Valkey unreachable. Re-sync on reconnect.
- Realtime bus: fallback to direct pg_notify (already in `lib/realtime-bus.ts` — verify + document).
- AI providers: provider rotation on 5xx (already partial — formalize).
- File storage: queue writes locally if S3 unreachable, replay on reconnect.
- Documented degradation matrix: which dependencies are critical vs optional.

**Effort.** 2-3 weeks.
**Dependencies.** Architectural decisions per subsystem.

---

### 1.6 Connection pool tuning — documented 🟡 P2
**Gap.** PgDog config exists, but tuning guide is missing. Default `pool_size=20` may be wrong for various deployments. Same for Kysely pool inside engine.

**Acceptance criteria.**
- `docs/PERFORMANCE-TUNING.md` covering: pool sizing per workload (read-heavy vs write-heavy), max connections vs RAM, PgDog vs no-pooler trade-offs.
- Worked examples: small (4 vCPU / 8GB), medium (16 vCPU / 32GB), large (64 vCPU / 128GB).

**Effort.** 2-3 days.
**Dependencies.** Benchmarks (1.1) must exist first.

---

## 2. Security & Compliance

### 2.1 Audit completeness — documented inventory 🔴 P0
**Gap.** Audit trail exists, but we don't have a complete inventory of **what is and isn't audited**. Compliance audits ask this. Right now: case-by-case reading of code.

**Why it matters.** GDPR DPIA, SOC2, ISO 27001, internal audits all require: "show me what's logged, with what fields, retained how long".

**Acceptance criteria.**
- `docs/AUDIT-COVERAGE.md` — table per resource type (collection, user, extension, permission, etc.) showing: what events trigger audit logs, what fields are captured, retention policy.
- Code-level test: assert audit log entry created for every privileged action (mutation tests).
- Filter UI in Studio audit log: by user, resource, action, IP range, time window.
- Export: CSV + JSONL for compliance auditors.

**Effort.** 1 week.
**Dependencies.** None.

---

### 2.2 Compliance reports auto-generation 🟠 P1
**Gap.** Audit trail is the raw material; compliance officers need formatted reports. Currently: they query DB directly. Should: one-click reports.

**Acceptance criteria.**
- GDPR DPIA report — data flow per collection, processing purpose, retention period, third parties.
- GDPR Subject Access Request (SAR) — all data about a user across collections.
- GDPR Right-to-Erasure — delete + audit trail of deletion, signed.
- Access log report — who accessed what in date range, exportable.
- Built as a `compliance/gdpr` extension (already exists — verify completeness).

**Effort.** 2-3 weeks (depends on existing extension state).
**Dependencies.** 2.1 audit completeness.

---

### 2.3 Per-field encryption — extends to user-defined PII fields 🟠 P1
**Gap.** Mail credentials + AI keys are encrypted (AES-256-GCM with separate KEKs). User-defined "encrypted" fields on collections — not yet first-class. PII columns (SSN, IBAN, etc.) need same treatment.

**Acceptance criteria.**
- Collection field option: `encrypted: true`.
- Engine transparently encrypts on insert, decrypts on read for authorized users.
- Key rotation supported (re-encrypt on KEK rotation).
- Decrypted access logged separately (sensitive-read audit).
- Performance acceptable for indexed encrypted fields (deterministic encryption for equality lookups vs random for other fields).

**Effort.** 2-3 weeks.
**Dependencies.** KMS integration (2.4) ideally.

---

### 2.4 Secrets management — external KMS integration 🟠 P1
**Gap.** Encryption keys currently in env vars (`MAIL_ENCRYPTION_KEY`, `AI_KEY_ENCRYPTION_KEY`). For real production: HashiCorp Vault, AWS KMS, GCP KMS, Azure Key Vault.

**Acceptance criteria.**
- Pluggable KMS provider abstraction (`lib/kms.ts`).
- Built-in: env-var KMS (today), HashiCorp Vault, AWS KMS, GCP Cloud KMS.
- Keys rotated without downtime.
- Documented integration per provider.

**Effort.** 2 weeks (for Vault + AWS; others follow).
**Dependencies.** None.

---

### 2.5 Rate limiting — adaptive + DDoS protection 🟠 P1
**Gap.** Per-tier rate limiting (auth, AI, write, destructive). No adaptive throttling (slow down abusers without hard-cutoff), no IP reputation, no behavioral patterns.

**Acceptance criteria.**
- Token bucket per (user, IP, route group).
- Adaptive: requests increasingly delayed for repeat offenders before being denied.
- IP allow-list / deny-list (CIDR support).
- Optional reCAPTCHA / hCaptcha gate for sensitive routes when abuse detected.
- Cloudflare integration docs (when CF is in front).

**Effort.** 2 weeks.
**Dependencies.** None.

---

### 2.6 Enterprise SSO — SCIM, JIT, group sync 🟠 P1
**Gap.** SAML + LDAP exist as extensions. SCIM provisioning, just-in-time user creation, group sync, multi-IdP federation = not yet.

**Acceptance criteria.**
- SCIM 2.0 endpoints (`/scim/v2/Users`, `/scim/v2/Groups`).
- JIT user creation on SAML/OIDC first sign-in.
- AD group → Zveltio role mapping (configurable).
- Multi-IdP — different tenants can have different IdPs.
- Audit log of SSO events.

**Effort.** 3-4 weeks.
**Dependencies.** Existing `auth/saml` + `auth/ldap` extensions.

---

### 2.7 Compliance certifications — SOC2 / ISO 27001 path 🟢 P3
**Gap.** No certifications. Enterprise contracts often require these.

**Why it matters.** Enterprise deals worth €100K+/year frequently won't sign without SOC2 Type 2 in particular.

**Acceptance criteria.**
- Pre-audit checklist documented in `docs/COMPLIANCE-PREP.md`.
- Engaged auditor (e.g., Drata, Vanta, Strike Graph for automation).
- Year 1 budget: €100-150K (SOC2 Type 1 + Type 2).
- Year 2-3: ISO 27001 + HIPAA-equivalent.

**Effort.** 6-12 months elapsed; budget €100-300K total.
**Dependencies.** Mature engineering + ops practices (audit trail completeness, vendor management, change management policies).

---

## 3. Performance & Scale

### 3.1 Performance regression testing in CI 🟡 P2 (partially shipped)
**Done.** CI has a `perf-smoke` job (`.github/workflows/ci.yml`) that boots the
compiled binary against Postgres and runs `bench/ci-check.ts` — CRUD + list p95
budgets that fail the build on catastrophic regression. Benchmark suite lives in
`bench/benchmarks/` (cold-start, list-pagination, realtime, rest-crud).

**Remaining (downgraded from P0).**
- Compare p95 to `main` and fail on >20% regression (today: absolute budgets only,
  "catastrophic regressions only").
- Public per-commit benchmark history / graph.
- Memory-leak regression in long-running tests.

**Effort.** 2-3 days.
**Dependencies.** None — extends the existing `perf-smoke` job.

---

### 3.2 Query optimization insights 🟠 P1
**Gap.** Slow query log exists (logs to console when > threshold). No structured analysis: which queries are slow, which are repeated, which need indexes.

**Acceptance criteria.**
- `/admin/insights/slow-queries` page — top-N slow queries, frequency, suggested index.
- pg_stat_statements integration.
- AI-assisted suggestion: "this query would benefit from `CREATE INDEX ON foo(bar)`".
- One-click apply (via DDL queue, no downtime).

**Effort.** 1-2 weeks.
**Dependencies.** Insights extension foundation exists.

---

### 3.3 N+1 query detection 🟡 P2
**Gap.** Easy to write N+1 patterns in extension code. No detection.

**Acceptance criteria.**
- Engine middleware that detects N+1 patterns per request.
- Logs warning + suggests batch alternative.
- `/admin/insights/n1` surfaces hot offenders.
- Documented in extension guide.

**Effort.** 1 week.
**Dependencies.** None.

---

### 3.4 Multi-region replication strategy 🟢 P3
**Gap.** Single Postgres instance. No documented multi-region strategy.

**Acceptance criteria.**
- Read replica support (Postgres logical replication).
- Realtime bus cross-region (Valkey cluster mode).
- Documented topology: primary in EU, read replicas in US/APAC.
- Conflict resolution for cross-region writes (probably "pinned writes to primary, reads from nearest replica").

**Effort.** 4-6 weeks.
**Dependencies.** Production scale signals (don't over-engineer before needed).

---

## 4. Developer Experience

### 4.1 Extension scaffolding wizard — `zveltio extension init` 🟠 P1
**Gap.** `zveltio extension init <name>` exists (CLI) but minimal — just folder structure. Could be a Yeoman-style wizard.

**Acceptance criteria.**
- Interactive prompts: extension name, category, what to include (engine routes, Studio pages, migrations, cron, slot contributions).
- Pre-fills `manifest.json` correctly.
- Scaffolds typed engine entry, Studio bundle config, vitest + integration test stubs.
- Demonstrates each contribution type in generated code.

**Effort.** 1 week.
**Dependencies.** None.

---

### 4.2 Better extension error messages 🟠 P1
**Gap.** When extension fails to load: `[extensions] Failed to load X: <stack>`. Could be much better — link to docs, suggest fix.

**Acceptance criteria.**
- Errors classified: signature mismatch, missing peerDep, bad migration, route conflict, capability denied.
- Each class has: human-readable message, link to docs section, concrete fix steps.
- Studio surfaces these in marketplace (red badge on extension with hover).

**Effort.** 1 week.
**Dependencies.** None.

---

### 4.3 Extension cookbook 🟠 P1
**Gap.** EXTENSION-DEVELOPER-GUIDE.md is reference-style. Lacks recipes ("How do I add a new field type?", "How do I send email on insert?", "How do I integrate Stripe?").

**Acceptance criteria.**
- `docs/EXTENSION-COOKBOOK.md` with 10-15 recipes covering common scenarios.
- Each recipe: problem statement, full working code, what to test, how to debug.
- Recipes for: custom field type, pre-write hook validation, scheduled job, webhook handler, AI provider integration, Studio slot widget, Stripe payment flow, audit trail customization.

**Effort.** 1 week.
**Dependencies.** None.

---

### 4.4 Migration tools — from Salesforce, HubSpot, Notion, Monday 🟠 P1
**Gap.** "I have 5 years of data in Salesforce. How do I move to Zveltio?" → no answer today.

**Why it matters.** Switch cost is the #1 blocker for adoption. Migration tools open enterprise market.

**Acceptance criteria per platform.**
- OAuth or API key auth to source.
- Schema introspection on source (Salesforce SObjects, HubSpot Properties, Notion Databases, Monday Boards).
- AI-assisted mapping to Zveltio collections.
- Incremental sync (start full, then delta).
- Conflict resolution UI.
- Verification: record count match, sample-data integrity check.
- Start with Salesforce → biggest market share + worst lock-in.

**Effort.** 4-6 weeks per platform.
**Dependencies.** None.

---

### 4.5 TypeScript types for ALL extension APIs 🟡 P2
**Gap.** Most extension surface is typed via `@zveltio/sdk/extension`. Some corners (`ctx.internals`) are `any`-shaped or under-typed.

**Acceptance criteria.**
- Audit every type-erased corner of `ExtensionContext`.
- Strong types for all internals: aiProviderManager, dynamicInsert, runEdgeFunction, generatePDF, etc.
- Generic param threading where DB schemas matter.
- Type tests (assignability assertions in `tests/unit/sdk-types.test.ts`).

**Effort.** 1 week.
**Dependencies.** None.

---

### 4.6 Testing helpers — better mocks + integration scaffolding 🟡 P2
**Gap.** `@zveltio/sdk/testing` has primitives (mockDb, mockAuth, withTestDb). Could go further — pre-seeded fixtures, common scenarios, snapshot helpers.

**Acceptance criteria.**
- Fixture library: pre-seeded users, collections, permissions, audit entries.
- Scenario helpers: "as authenticated user X", "with collection Y of N records", "with extension Z enabled".
- Snapshot testing for API responses (jest-snapshot-style).
- Documented in cookbook (4.3).

**Effort.** 1-2 weeks.
**Dependencies.** 4.3 cookbook.

---

## 5. Manager-Facing Capabilities

### 5.1 Live public demo — `demo.zveltio.com` 🔴 P0
**Gap.** Nothing for evaluators to click without installing.

**Why it matters.** Biggest blocker for non-technical evaluation. Manager can't get IT to install just to see if worth a meeting.

**Acceptance criteria.**
- `demo.zveltio.com` — fresh Zveltio instance, reset daily at 03:00 UTC.
- Pre-seeded with: 1 demo company, 50 contacts, 30 deals, 5 users with different roles, 100 audit entries, 3 plugins enabled (CRM, mail, flows).
- Read-only mode for `god` user (no destructive actions).
- Public "deploy your own" button with one-click DigitalOcean / Hetzner template.
- IP rate limit + bot detection.

**Effort.** 1-2 weeks.
**Dependencies.** Stable build (alpha.82 is good enough).

---

### 5.2 Pre-built business templates — one-click installs 🔴 P0
**Gap.** Installing Zveltio = empty platform. No "starter kit" for common business types.

**Why it matters.** Instant value during evaluation. Manager sees CRM working in 30s vs reading docs for 30 minutes.

**Acceptance criteria.**
- Marketplace category: "Templates".
- 5 initial templates: **CRM Starter** (contacts + deals + activities), **HR Suite** (employees + leave + reviews), **Project Management** (projects + tasks + boards), **Helpdesk** (tickets + SLAs), **Invoicing** (clients + invoices + payments).
- Each template = bundle of: collections + permissions + Studio pages + sample data + onboarding tour.
- Install: one click, 30s install, instant working app.
- Variants: minimal vs full-featured.

**Effort.** 1 week per template; 5 templates ~5 weeks total (can parallelize).
**Dependencies.** Existing plugins (CRM, HR, projects) cover most. Polish for "starter" experience.

---

### 5.3 Visual schema designer — ERD + drag-drop 🔴 P0
**Gap.** Collection editor is form-based. Power users want ERD view + drag-drop fields + visual relationship designer.

**Why it matters.** Managers and analysts can structure data themselves without involving developers.

**Acceptance criteria.**
- `/admin/collections/designer` — ERD canvas.
- Collections as boxes, fields as rows, foreign keys as lines.
- Drag-drop to add field. Click to edit.
- Drag from one collection to another = creates relation.
- Validation: shows orphaned relations, ambiguous types, missing required fields.
- Auto-layout (force-directed graph).
- Export as PNG / SVG / SQL.

**Effort.** 3-4 weeks.
**Dependencies.** None. SvelteFlow or similar.

---

### 5.4 Visual workflow builder — polish 🟠 P1
**Gap.** Flow builder exists (node-based), but UX is developer-first. n8n / Zapier have better polish for non-technical users.

**Acceptance criteria.**
- Step library searchable.
- Drag-drop with snap-to-grid.
- Conditional branching visualized cleanly.
- Test mode: run flow with sample data, see results inline.
- Templates: "When new contact added → send welcome email", "When deal closed → create invoice + Slack notification".

**Effort.** 3-4 weeks.
**Dependencies.** Existing flow builder.

---

### 5.5 Cost calculator on website 🟠 P1
**Gap.** README says "save €2-5k/month" but vague. Interactive calculator = concrete ROI for managers.

**Acceptance criteria.**
- `zveltio.com/cost-calculator` — interactive page.
- Inputs: company size (employees), current SaaS (checkboxes: Salesforce, HubSpot, Mailchimp, Monday, Notion, etc.), team region.
- Output: monthly SaaS cost, monthly Zveltio cost (incl. support tier), annual savings, 3-year TCO.
- Shareable URL (UTM-tracked).
- Save result as PDF for internal pitch.

**Effort.** 3-5 days.
**Dependencies.** None.

---

### 5.6 AI Business Agents — autonomy beyond chat 🟢 P3
**Gap.** AI extension has chat + schema generation + text-to-SQL. No autonomous agents that operate on data continuously.

**Why it matters.** Premium differentiator. Sweet spot for EU AI funding (Horizon, POCIDIF). Manager ROI is measurable: replace data-entry teams.

**Acceptance criteria.**
- Agent definition: triggers (cron, event, mention) + actions (categorize, suggest, alert, draft response).
- 5 starter agents: Sales (categorize email, prioritize deals), Finance (anomaly detection), Customer Service (route tickets), HR (review summarization), Operations (inventory alerts).
- Sandbox: agents see only data they're scoped to.
- Audit: every agent action logged + reviewable.
- Cost controls: token budgets per agent.
- Studio UI: agent dashboard with run history, cost, action approval queue.

**Effort.** 6-8 weeks.
**Dependencies.** AI provider abstraction (exists), edge functions (exists), audit trail (exists).

---

### 5.7 Mobile-first Studio admin 🟡 P2
**Gap.** Studio works on mobile but isn't optimized. Managers check status on phone — touch targets too small, tables don't reflow well.

**Acceptance criteria.**
- Responsive audit: every admin page reviewed at 375px wide.
- Touch targets ≥44×44px.
- Tables: stack-on-mobile or horizontal-scroll with sticky first column.
- Bottom-sheet navigation for mobile.
- Dashboard reflows: 1-column on mobile.

**Effort.** 2 weeks.
**Dependencies.** None.

---

### 5.8 Native real-time collaboration (CRDTs) 🟢 P3
**Gap.** No multi-user simultaneous editing on records. Notion + Slack baseline expectations.

**Acceptance criteria.**
- Yjs integration in collection record editor.
- Presence indicators ("3 users editing now").
- Comments + @mentions on any record.
- Activity feed live.
- Replaces a meaningful slice of Notion + Slack for business teams.

**Effort.** 6-8 weeks.
**Dependencies.** None.

---

## 6. Internationalization

### 6.1 Studio UI translations — major EU languages 🟠 P1
**Gap.** Paraglide setup with en + ro. To reach EU market: at minimum de, fr, es, it, nl, pl, pt.

**Acceptance criteria.**
- 7 additional locales added.
- Translation workflow: extract keys from source, push to translation service (e.g., Crowdin), import back.
- Locale switcher in Studio top bar.
- Per-user preference persisted.

**Effort.** 2 weeks (assuming hired translators — €2-5k cost).
**Dependencies.** Hiring translators.

---

### 6.2 Multi-locale content support 🟡 P2
**Gap.** Translations extension exists for content keys. Per-collection multi-locale fields (e.g., product description in 5 languages) — not first-class.

**Acceptance criteria.**
- Field option: `localized: true`.
- Engine stores as JSON `{ en: "...", de: "...", fr: "..." }`.
- API: returns field in `Accept-Language` locale, falls back to default.
- Studio UI: language tabs in field editor.

**Effort.** 1 week.
**Dependencies.** None.

---

### 6.3 Per-tenant formatting (currency, date, number) 🟡 P2
**Gap.** Studio displays numbers / dates in fixed format. Tenants in different regions need locale-aware display.

**Acceptance criteria.**
- Tenant setting: locale + currency.
- Studio components respect: `<Money amount={...} />`, `<DateTime value={...} />`, `<Number value={...} />`.
- Intl.NumberFormat / Intl.DateTimeFormat used consistently.

**Effort.** 1 week.
**Dependencies.** None.

---

## 7. Ecosystem & Community

### 7.1 3rd party extension contributions 🔴 P0
**Gap.** All 54 extensions are first-party. For marketplace to be a "marketplace" (not a "catalog"), need 3rd party contributors.

**Why it matters.** Sustainability post-grant. Evidence of platform vitality for evaluators.

**Acceptance criteria.**
- Developer outreach plan: identify 10-20 candidate developers (Twitter / GitHub / Reddit FOSS community).
- Bounty program: €500-2000 per extension built (specific list: Stripe payments, Sendgrid email, Plausible analytics integration, Notion sync, etc.).
- "Zveltio Certified Extension" badge with quality criteria.
- Featured 3rd party extensions on apps.zveltio.com.
- Aim: 20 3rd-party extensions in 6 months.

**Effort.** Ongoing program; ~€20-40K bounty budget Year 1.
**Dependencies.** apps.zveltio.com exists; developer.zveltio.com exists.

---

### 7.2 Public community presence 🔴 P0
**Gap.** No Discord, no GitHub Discussions, no public chat. Community is invisible.

**Acceptance criteria.**
- GitHub Discussions enabled with categories: announcements, Q&A, show & tell, ideas.
- Discord server: public invite link, channels for #general / #help / #showcase / #dev / #extensions.
- Weekly office hours (Liviu + community).
- Linked from README + website footer.

**Effort.** 1 day setup; ongoing time investment.
**Dependencies.** Liviu + 1-2 core contributors committed to responding.

---

### 7.3 Reference customer case studies 🔴 P0
**Gap.** Zero public case studies. Manager-facing decision blocker.

**Acceptance criteria.**
- Pilot 3-5 customers (free or paid).
- 3-page case study per customer: problem, what they replaced, metrics (cost saved, time saved), quote, lessons learned.
- Featured on `zveltio.com/case-studies`.
- Linked from README + frontpage.

**Effort.** 2-3 months elapsed (recruit + implement + measure + write).
**Dependencies.** Live demo + templates (5.1, 5.2) to lower switch cost.

---

### 7.4 Tech support — paid tiers on website 🔴 P0
**Gap.** Plan exists (paid support team), but no public offering. Enterprise can't even ask.

**Acceptance criteria.**
- `zveltio.com/support` page with tiers:
  - **Community** (free) — GitHub issues, Discord
  - **Standard** (€500/month) — email support, 1-business-day response, upgrade assistance
  - **Business** (€2000/month) — Slack channel access, 4-hour response, monthly check-in, priority bug fixes
  - **Enterprise** (€5000+/month, custom) — dedicated engineer, SLA, on-call, custom development quota
- Per-tier coverage matrix.
- Add-ons: training, implementation help, migration assistance (hourly).
- Stripe / SCA-compliant checkout for self-serve Standard / Business.

**Effort.** 1 week (page + Stripe integration).
**Dependencies.** Support team hiring (separate workstream).

---

### 7.5 Partner / agency program 🟠 P1
**Gap.** No agencies trained to implement Zveltio for clients. Reach limited.

**Acceptance criteria.**
- "Zveltio Certified Partner" program: training course (online), certification exam, listed on website.
- Referral commission: 20% of first-year support contract.
- Co-marketing: featured agency partners on website.
- Slack channel for partners (private).
- Aim: 5-10 partner agencies in Year 1.

**Effort.** 4-6 weeks setup (training material, exam, agreements).
**Dependencies.** Tech support pricing (7.4) first.

---

## 8. Long-term Differentiation

### 8.1 Federated multi-instance — ActivityPub for business apps 🟢 P3
**Gap.** Each Zveltio instance is islanded. Two consulting firms can't share contact records across instances.

**Acceptance criteria.**
- Identity federation: trust certificates between instances.
- Selective data sharing: per-collection, per-record share with another instance.
- Conflict resolution: CRDTs for distributed edits.
- Discovery: well-known endpoint for federated capabilities.
- Use case: consortium of companies share supplier database without central server.

**Effort.** 3-4 months R&D.
**Dependencies.** Real-time collaboration (5.8) provides CRDT foundation.

---

### 8.2 Privacy-preserving analytics 🟢 P3
**Gap.** Cross-tenant analytics impossible without exposing data. Federated learning + differential privacy = enables analytics without data leakage.

**Acceptance criteria.**
- Differential privacy library integrated.
- Federated learning: train ML model across tenants without sharing raw data.
- Use case: industry benchmark dashboards ("how does my retention compare to peers?") with mathematical privacy guarantees.

**Effort.** 4-6 months R&D.
**Dependencies.** Specialized ML knowledge.

---

### 8.3 Extension architecture v2 — install in <1s 🟢 P3 — **partially shipped (SDUI)**

> **Update (2026-06):** "Option A — lazy-load extension UI routes" below is now
> **implemented for declarative pages** (SDUI). An extension page can ship as
> `studio/schemas/<slug>.json` instead of a `+page.svelte`; the engine inlines it
> into `/api/extensions` and the Studio catch-all route (`[...extPath]`) renders it
> with trusted generic host components (`SchemaPage`/`SettingsPage`) — **zero build
> toolchain, sub-second enable, no third-party JS in the admin**. 22/54 first-party
> extensions are migrated (the CRUD/multi-tab/settings/cards/master-detail shapes).
> The remaining ~32 keep code `+page.svelte` (bespoke editors/canvases/maps/kanban/
> chat/file-browsers) and still use the release-time bake. See the EXTENSION-DEVELOPER-GUIDE §10
> and `packages/studio/src/lib/sdui/`. What's left of this item: a dynamic-columns
> primitive (would unlock the DB browser) and retiring the `STUDIO_SRC_DIR` rebuild
> path once the bespoke set is also handled (iframe escape or release-bake only).

**Gap (original).** Current Studio extension model for **code pages**: source ships
in tarball, Studio rebuilds with copy-in (10-30s per enable). Could be sub-second.

**Why later (not now).**
- Current model has been hardened through 14 alpha iterations (alpha.60 dropped Bun.plugin shims because they don't work in compiled binaries; alpha.71-74 dropped dynamic Svelte runtime sharing because it caused freeze).
- No active users currently complain about install time — we don't have install time complaints because we don't have install volume yet.
- Touching the extension architecture risks regressions on a battle-tested system.
- Adoption blockers (live demo, templates, cost calculator, case studies) deliver 10× the user-facing impact per engineer-week.

**Two explorations worth doing eventually:**

**Option A — Lazy-load extension UI routes**
- Studio built once without per-extension routes baked in.
- Catch-all `[...path]` route does runtime resolution: fetches the extension's compiled bundle, mounts via Svelte 5 `mount()` API.
- ✅ Install = no rebuild (~1s).
- ⚠️ Loses SvelteKit's per-route prefetch + data loading + clean URLs.
- ⚠️ Svelte 5 `mount()` is new; alpha.71-74 era issues with runtime sharing need re-verification.
- Effort: 1 week + extensive testing.

**Option B — Pre-compile at publish, not at install**
- `zveltio extension publish` compiles Studio components against locked Svelte/Tailwind/Lucide versions.
- Install = copy pre-compiled artifacts.
- ✅ Install = ~instant.
- ⚠️ Version matrix problem: extension built for Svelte 5.51 breaks when Studio upgrades to 5.52.
- ⚠️ Requires version contracts: manifest declares target versions; Studio refuses incompatible extensions.
- Or: fastpath (pre-compiled if match) + fallback (source rebuild) — doubles complexity.
- Effort: 2-3 weeks + version matrix infrastructure.

**Pre-conditions to consider for adoption.**
- ≥100 active deployments complaining about install time.
- ≥20 3rd-party extensions in ecosystem (post-7.1).
- Strategic decision to invest in extension architecture v2 vs other P0/P1 work.

**Until then.** The current architecture works. Document it well. Move on.

---

### 8.4 Industry-specific compliance packs 🟢 P3
**Gap.** Romanian compliance is the only country pack. Healthcare (HIPAA EU-equivalent), finance (PSD2 / MiCA), public sector (eIDAS 2.0) = vertical market unlocks.

**Acceptance criteria per pack.**
- Healthcare: pseudonymization defaults, HL7 / FHIR field types, consent flows, BAA-equivalent audit trail.
- Finance: PSD2 strong customer authentication, MiCA crypto-asset tracking, AML watchlist screening, regulatory reporting templates.
- Public sector: eIDAS 2.0 wallet integration, FOIA-equivalent transparency reports, archival retention policies.
- Each pack = bundle of extensions + Studio templates + compliance documentation.

**Effort.** 2-3 months per pack.
**Dependencies.** Compliance certifications (2.7) for serious adoption.

---

## 9. Cross-cutting verification

### 9.1 Mutation testing in CI 🟡 P2
**Gap.** 377 tests pass. But coverage % doesn't tell us if tests actually catch bugs. Mutation testing introduces deliberate bugs and verifies tests catch them.

**Acceptance criteria.**
- Stryker (or similar) integrated in CI.
- Mutation score target: ≥70% on security-critical paths (auth, RBAC, RLS), ≥50% overall.
- Weekly mutation report.

**Effort.** 1-2 weeks setup + ongoing maintenance.
**Dependencies.** Existing test suite.

---

### 9.2 Property-based testing for invariants 🟡 P2
**Gap.** Unit tests check specific inputs. Property tests check invariants across input space (e.g., "RLS policy is never bypassed for any input").

**Acceptance criteria.**
- fast-check integrated.
- Properties tested: RLS bypass invariants, audit log completeness, encryption round-trip, schema migration correctness.
- ≥20 property tests across critical paths.

**Effort.** 1-2 weeks.
**Dependencies.** None.

---

### 9.3 Chaos testing for DDL queue + extensions 🟡 P2
**Gap.** What happens if engine crashes mid-DDL? Mid-extension-install? Currently: hope.

**Acceptance criteria.**
- Test harness that kills engine at random points during: DDL apply, extension install, migration run.
- Assert: no orphan tables, no half-installed extensions, no torn audit log entries.
- Recovery procedures verified.

**Effort.** 2 weeks.
**Dependencies.** DR procedures (1.2).

---

### 9.4 Fuzzing on user-input boundaries 🟡 P2
**Gap.** Input validation tested with specific cases. Fuzzing tests random / adversarial input.

**Acceptance criteria.**
- Fuzz targets: RLS policy parser, SQL builder (Kysely is solid but our wrappers might not be), JSON field validators, file upload handlers.
- libFuzzer (or jazzer.js for TypeScript) integrated.
- Continuous fuzzing job: 1 hour per night on each target.

**Effort.** 2 weeks setup; ongoing.
**Dependencies.** None.

---

## Priority summary

### 🔴 P0 (do before v1.0 — 10 items)

| # | Item | Effort |
|---|---|---|
| 1.1 | Performance benchmarks | 1 week |
| 1.2 | Disaster recovery procedures | 1 week |
| 2.1 | Audit completeness inventory | 1 week |
| 3.1 | Performance regression in CI | 3-5 days |
| 5.1 | Live public demo | 1-2 weeks |
| 5.2 | Pre-built business templates (5) | ~5 weeks (parallel) |
| 5.3 | Visual schema designer | 3-4 weeks |
| 7.1 | 3rd party extension contributions program | ongoing |
| 7.2 | Public community presence | 1 day setup |
| 7.3 | Reference customer case studies | 2-3 months elapsed |
| 7.4 | Tech support paid tiers on site | 1 week |

**Total focused engineering**: ~12-16 weeks if 1 engineer, ~6-8 weeks if 2 engineers.

### 🟠 P1 (v1.0 polish — 16 items)

Observability, graceful degradation, compliance reports, secrets management, SSO, query insights, extension scaffolding, migration tools, i18n, partner program, etc. Total: 4-6 months of engineering.

### 🟡 P2 (nice for v1.0) and 🟢 P3 (post-v1.0 strategic)

Detailed in document sections above.

---

## Honest blocker for serious adoption

The single biggest gap right now is **trust signals**:
- No benchmarks → "is it actually fast?"
- No DR runbooks → "what happens when something breaks?"
- No demo → "can I see it work?"
- No case studies → "anyone else using it?"
- No paid support tier → "who supports us if we go live?"
- No 3rd party plugins → "is the ecosystem alive?"

P0 items address exactly these. Once they're done, the technical product is at "trustable for adoption". Marketing then has a real foundation.

---

## Decision matrix — what to do this quarter

If you have **1 month**: live demo + templates + cost calculator + tech support pricing + community presence. These convert evaluators to users.

If you have **3 months**: above + benchmarks + DR + visual schema designer + audit inventory + 3rd party extension bounties. These build trust for serious adoption.

If you have **6 months**: above + observability dashboards + migration tools + compliance docs + reference customer case studies + i18n. This is "production-ready" v1.0.

If you have **12 months and €3M (POCIDIF scope)**: above + AI Business Agents + federated multi-instance + privacy-preserving analytics + industry packs + SOC2 prep. This is "category-defining product".
