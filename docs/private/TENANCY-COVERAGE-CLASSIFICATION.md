# §6 — Cele 20 de tabele fără politică, împărțite

*2026-08-26. Prima lucrare cerută de `TENANCY-HIERARCHY-DESIGN.md` §6. Fiecare
rând de mai jos are un motiv verificat în cod sau probat pe o bază vie, nu dedus.*

---

## Cum s-a măsurat

Bază construită în ordinea din `project_ext_contract_suite_recipe`: bază virgină
→ schema engine (harness) → migrațiile extensiilor (suita de contract, 590/590)
→ un al doilea boot al engine-ului, ca reconcilierele să ruleze. Rezultat:
**382 de tabele, 315 politici**.

```sql
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r'
  AND EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
  AND NOT EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname='public' AND p.tablename=c.relname);
```

### Prima corecție la lista din §6: 20 → 16 + 4

Pe o instalare curată golul e de **16 tabele**, nu 20. Cele patru care lipsesc —
`zvd_pages`, `zvd_views`, `zvd_zones`, `zvd_page_views` — **nu există pe o
instalare curată**. Sunt tabelele *vechi* din care `content/pages`
migrează (`001_initial.sql` al extensiei le citește o dată, ca sursă, și scrie
`zv_pages` / `zv_page_sites`). Apar în baza de referință pe care s-a măsurat §6
fiindcă aceea era o bază moștenită dinainte de fuziunea `content/pages`.

Nu intră în migrație. Sunt reziduu de upgrade, nu lipsă de acoperire — și pe
bazele unde chiar există, `zvd_pages`/`zvd_views`/`zvd_zones` sunt oricum în
lista de built-ins a lui `reconcileTenantRLS`, deci primesc politică la primul
boot de după ce ajung să existe.

---

## A. Legitim inter-firme — NU primesc politică (11)

Criteriul nu e „pare administrativ". E: **întrebarea la care răspunde tabela se
pune înainte să existe o firmă curentă**, sau se pune despre toate firmele
deodată. O politică aici nu e prudență în plus, e o eroare de model.

| tabelă | de ce nu |
|---|---|
| `zv_tenant_users` | `getUserTenants()` (`tenant-manager.ts:445`) răspunde la „în ce firme sunt?" — întrebarea de *dinainte* de a alege firma. Cu politică, lista de firme la login e goală și nimeni nu mai poate comuta. |
| `zv_api_keys` | `validateApiKey()` (`lib/data/auth.ts:96`) caută **doar după hash**; cheia e cea care *stabilește* firma. Comparația cu firma cerută vine imediat după (`auth.ts:119`) și e corectă. Cu politică, autentificarea prin cheie API cade în întregime. |
| `zv_invitations` | Răscumpărată **după token, de un neautentificat care încă nu e membru nicăieri** (`routes/auth.ts:90,123`). `/api/auth` e în `TXN_SKIP_PREFIXES`, deci nici nu există tranzacție de firmă. Tokenul *e* capabilitatea. |
| `zv_environments` | `resolveEnvironment()` e chemată **din interiorul lui `tenantMiddleware`, înainte** ca `withTenantIsolation` să deschidă tranzacția (`middleware/tenant.ts:75`). O politică aici rupe rezolvarea firmei — adică tot. Filtrează explicit pe `tenant_id`. |
| `zv_tenant_usage` | Scrisă de `tenant-quota.ts:136` pe `quotaDb = poolDb ?? db` — pool, în afara tranzacției cererii, prin construcție. Citită agregat pe instanță de `/api/admin/system`. E registrul contabil al instanței. |
| `zv_extension_registry` | Citită la boot (`index.ts:532,561`), fără nicio cerere. Extensiile se instalează per **instanță**, nu per firmă. |
| `zvd_webhooks` + `zvd_webhook_deliveries` | Comentariul e chiar în cod (`lib/webhooks.ts:120`): *„the dispatcher runs on the GLOBAL pool, not inside the request transaction, so it can't read `current_setting('zveltio.current_tenant')`"*. Filtrează explicit pe `tenant_id` primit ca argument. Cu politică, dispecerul ar vedea zero rânduri și **webhook-urile ar înceta tăcut** pentru toate firmele nenormate. |
| `zv_dashboards` | `insightsRoutes(poolDb, auth)` (`routes/index.ts:458`) — **pe pool**, deliberat: ruta pune `SET TRANSACTION READ ONLY` și un `statement_timeout` proprii, care n-au ce căuta pe toată cererea. De aceea filtrează manual, cu `tenantOf(c)`, la fiecare acces. |
| `zv_flows` | `flowsRoutes(poolDb, auth)` (`routes/index.ts:482`), plus `flow-scheduler.ts:90` care deschide **propria tranzacție pe `_db`, fără `SET LOCAL ROLE` și fără GUC** — trebuie să vadă flow-urile scadente ale tuturor firmelor, altfel nu le poate rula. |
| `zv_revisions` | `afterWrite` scrie jurnalul **pe pool**, și codul o spune (`write-pipeline.ts:411`): *„afterWrite runs on the pool, not the request transaction, so it can't rely on the RLS GUC"*. Pune `tenant_id` explicit. |

**Rezerva pe ultimele patru.** `zv_dashboards`, `zv_flows`, `zv_revisions` și
perechea de webhook-uri sunt *legitim inter-firme la scriitorul/cititorul lor de
fundal*, nu în principiu. Politica ar fi corectă ca model și greșită ca execuție:
`zveltio_tenant_scope_ok` fără GUC cade pe firma implicită, deci ar tăia tăcut
exact firmele nenormate. Sunt marcate „nu acum" cu o condiție scrisă, nu
închise: se acoperă când apelantul de fundal e mutat pe `withTenantIsolation`,
care e o lucrare cu rază proprie. `zv_revisions` e cazul cel mai neplăcut —
`INSERT`-ul are `.catch(...console.error)`, deci o politică pusă azi ar face
jurnalul de audit să eșueze *într-o linie de log*, nu într-o eroare.

Un detaliu care ține de §6: în `content/drafts/engine/routes.ts:366` există un
`COUNT(*)` pe `zv_revisions` **fără filtru de firmă** (numerotarea versiunilor
de ciornă). Nu scurge conținut, dar numără rândurile altei firme — de reparat
separat, la sursă.

---

## B. Lipsă de acoperire — INTRĂ în migrație (5)

Criteriul: **fiecare acces existent poartă deja un filtru de firmă sau ar trebui
să poarte**, nimic nu le citește fără context, și absența politicii e o scăpare.

| tabelă | de ce da |
|---|---|
| `zv_checklist_scoring_schemes` | Vezi proba de mai jos. **Scurgere dovedită.** |
| `zv_checklist_scheme_weights` | Aceeași omisiune, aceeași migrație. |
| `zv_checklist_scores` | Aceeași omisiune. Conține scorul și `snapshot`-ul unei inspecții. |
| `zv_record_comments` | Toate cele 4 accese sunt în `routes/revisions.ts`, pe `db` (deci în tranzacția firmei), toate deja cu `tenant_id = ${tenantId(c)}`. Politica e strict apărare în adâncime, fără risc de regresie. |
| `zv_saved_queries` | Toate cele 8 accese sunt în `routes/saved-queries.ts`, pe `db`, toate deja filtrate. Idem. |

### De ce cele trei tabele de scoring — mecanismul exact

`workflow/checklists/engine/migrations/002_tenant_rls.sql` enumeră **o listă
fixă** de cinci tabele și le pune politici. `004_scoring_schemes.sql` adaugă
**încă trei** tabele cu `tenant_id`, două migrații mai târziu, și face doar
`GRANT ... TO zveltio_rls` — niciun `ENABLE ROW LEVEL SECURITY`, nicio politică.

`reconcileExtensionTenantRLS` nu le poate salva: el adoptă, prin construcție,
doar tabelele care *declară deja* o politică `tenant_isolation_*`. O tabelă care
n-a avut niciodată una e invizibilă pentru el.

### Proba — nu mai e „neverificat"

§6 spunea: *„Nu am verificat dacă vreuna e exploatabilă."* Una este. Rulat pe
baza vie, sub rolul `zveltio_rls`, adică exact rolul pe care îl ia cererea:

```
=== firma B citește PĂRINTELE protejat (zv_checklist_templates) ===
 rows_b_can_see
----------------
              0

=== firma B citește COPILUL neprotejat — interogarea rutei, verbatim ===
      name       |       description        |              tenant_id
-----------------+--------------------------+--------------------------------------
 A secret scheme | A confidential threshold | 11111111-1111-1111-1111-111111111111
```

Ruta e `GET /ext/workflow/checklists/templates/:id/scoring-schemes`
(`routes.ts:1013`): interoghează `zv_checklist_scoring_schemes` direct, după
`template_id` **luat din URL**, fără să treacă întâi prin
`zv_checklist_templates`. Sora ei, `POST` pe aceeași cale (`routes.ts:1045`),
*are* garda — caută întâi șablonul, care e protejat, și dă 404 pe un id străin.
Deci nu e o decizie, e o omisiune într-una din două rute gemene.

Orice utilizator autentificat în firma B, cu un UUID de șablon din firma A,
citește numele, descrierea și pragul de trecere ale schemelor de punctaj ale
firmei A.

---

## C. Ce înseamnă asta pentru lucrarea principală

Cele două numere din §6 se schimbă și trebuie schimbate în plan:

- politicile de recreat rămân **315** — niciuna dintre cele de mai sus nu era
  între ele;
- migrația **adaugă 5 politici noi**, deci verificarea de la §6 devine
  „**320** de politici de firmă, toate cu `zveltio_tenant_write_ok` în
  `WITH CHECK`", nu 315. Migrația se oprește dacă numărul nu se potrivește.

Cele patru din §A cu rezervă (`zv_dashboards`, `zv_flows`, `zv_revisions`,
`zvd_webhooks`+`zvd_webhook_deliveries`) rămân în afara migrației **cu motiv
scris**, nu din uitare. Sunt intrarea naturală a lucrării din
`TRANSACTION-BOUNDARY-HANDOFF.md`, care e exact despre cine rulează pe pool și
cine în tranzacția cererii.
