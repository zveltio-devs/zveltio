# Multi-tenancy în Zveltio — cum funcționează, de fapt

> Scris pentru cineva care va **audita** codul. Scopul nu e să convingă că e
> bine, ci să spună exact ce e — inclusiv unde e fragil — ca timpul de audit să
> se ducă pe ce contează, nu pe presupuneri.
>
> Fiecare afirmație de aici e verificabilă cu o comandă. Unde am pus cifre, sunt
> măsurate, iar comanda e alături.

---

## 0. Rezumatul de care ai nevoie dacă citești un singur paragraf

O instalare servește **mai multe firme**, ierarhic (corporații cu societăți,
instituții cu unități subordonate). Izolarea NU e la nivel de schemă și nici de
bază: e **shared schema + coloană `tenant_id`**, aplicată de **Postgres RLS**.

Faptul central, din care decurge tot restul:

> **Motorul se conectează la Postgres ca superutilizator.** Un superuser
> **ocolește RLS întotdeauna**. Politicile NU protejează nimic pe conexiunea de
> pool. Ele se aplică doar înăuntrul tranzacției cererii, unde motorul face
> `SET LOCAL ROLE zveltio_rls` și coboară privilegiile.

Deci întrebarea centrală a oricărui audit al acestui sistem este:

> **Ce cod atinge date de firmă în afara acelei tranzacții?**

Măsurat pe o bază reală, ca să nu fie o afirmație teoretică:

```
pool brut, rol postgres              : 2 rânduri — firma A + firma B   ← RLS NU protejează
tranzacție de firmă, rol zveltio_rls : 1 rând    — firma A             ← RLS protejează
```

---

## 1. Cele patru straturi, și ce se întâmplă dacă unul e uitat

| # | strat | ce decide | unde rulează | dacă e uitat |
|---|---|---|---|---|
| 1 | **Casbin** | dacă utilizatorul are voie să facă *acțiunea* | motor | **scurgere** |
| 2 | **Politici RLS pe `tenant_id`** | *care rânduri* vede sesiunea | Postgres | nimic — baza refuză |
| 3 | **Reguli de rând ale produsului** | „vezi doar ce ai creat" etc. | Postgres **și** motor | nimic — baza refuză |
| 4 | **`where tenant_id = …` explicit** | performanță, plus curea | motor | de obicei nimic (2 acoperă) |

Un auditor care judecă stratul greșit ajunge la concluzii greșite. Cel mai
frecvent: raportează lipsa lui 4 ca scurgere, când 2 o acoperă. Sau invers,
presupune că 2 acoperă ceva ce rulează în afara tranzacției, unde nu se aplică.

---

## 2. Ciclul unei cereri

```
sessionPrefetch        rezolvă sesiunea PE POOL, ca rolul motorului
   ↓
tenantMiddleware       rezolvă firma, deschide UNA tranzacție,
                       coboară rolul + publică zece variabile de sesiune
   ↓
tenantMembership       cere apartenență pentru firme non-implicite
   ↓
handler                totul rulează în acea tranzacție
```

**De ce `sessionPrefetch` e primul, și nu e un detaliu.** Rolul `zveltio_rls` nu
are drept de citire pe tabelele Better-Auth (`session`, `account`). O interogare
de sesiune înăuntrul tranzacției răspunde `permission denied for table session`,
iar refuzul **abortează tranzacția**, luând cu el tot restul cererii. Deci
sesiunea se rezolvă înainte, pe pool, cu rolul motorului.

### Rutele care NU deschid tranzacție

`TXN_SKIP_PREFIXES` din `middleware/tenant.ts`:

```
/api/health  /api/metrics  /api/auth  /api/openapi
/api/collections  /api/relations  /api/schema  /api/templates
/api/tenants
/api/insights  /api/flows  /api/backup  /api/admin/sql
```

Ultimele patru sunt construite pe `poolDb` și **nu e o scăpare, e o reparație**.
O cerere în tranzacție a rezervat deja o conexiune; un handler pe `poolDb` cere a
doua. La concurență egală cu dimensiunea pool-ului, fiecare cerere ține una și
așteaptă una, și nimic nu se mai eliberează:

| `DB_POOL_MAX` | concurență | erori | p95 | stări în pool |
|---:|---:|---:|---:|---|
| 10 | 5 | 0 | 19,6 ms | `idle in transaction × 4` |
| 10 | **10** | **10 din 10** | **9 724 ms** | `idle in transaction × 10`, `active × 1` |

Nu e degradare, e oprire. Cele patru filtrează explicit prin `tenantOf(c)` —
trebuie, fiind pe pool — iar `backup` și `sql-editor` sunt unelte de instanță,
fără scop de firmă. Poarta `check:pooldb-txn` păzește lista.

`/api/tenants` sare pentru alt motiv: **administrarea firmelor nu e muncă
ÎNĂUNTRUL unei firme.** Provizionarea scrie rândul firmei prin pool — trebuie,
fiindcă o firmă existentă doar într-o tranzacție necomisă nu poate fi referită de
nimic — apoi scrie primul ei mediu. Rulate în tranzacție de firmă, cele două
scrieri ajungeau pe conexiuni diferite și a doua pica pe cheie străină.

---

## 3. Cele zece variabile de sesiune

Toate scrise **într-un singur round-trip**, toate `is_local = true`, deci
tranzacționale:

```sql
set_config('role',                      'zveltio_rls', true)
set_config('zveltio.current_tenant',    <uuid>,        true)
set_config('zveltio.visible_tenants',   <uuid,uuid…>,  true)
set_config('zveltio.ancestor_tenants',  <uuid,uuid…>,  true)
set_config('zveltio.user_id',           <id>,          true)
set_config('zveltio.user_email',        <email>,       true)
set_config('zveltio.user_role',         <rol>,         true)
set_config('zveltio.user_roles',        <rol,rol…>,    true)
set_config('zveltio.actor',             'on' | 'off',  true)
set_config('zveltio.rls_bypass',        'on' | 'off',  true)
```

`role` călătorește ca variabilă, nu ca `SET LOCAL ROLE` separat — e un GUC ca
oricare altul, iar unirea taie un round-trip: **0,230 ms → 0,175 ms** pentru
pregătirea per cerere.

### De ce `zveltio.actor` e un steag propriu

Ăsta e un detaliu care arată redundant și **nu e**. O regulă de rând trebuie să
distingă două situații: o cerere a cărei identitate are un câmp gol, și muncă de
fundal care n-are identitate deloc. Nu se pot citi din aceeași setare:

```
după SET LOCAL + COMMIT   →  ''      setarea supraviețuiește, GOLITĂ
pe o conexiune curată     →  NULL
```

Deci `current_setting(x, true) IS NULL` înseamnă **„prima cerere pe o conexiune
proaspătă din pool"**, nu „fără identitate". Un predicat de securitate construit
pe absență ar depinde de norocul din pool și ar trece orice test rulat pe un pool
rece. `set_config(x, NULL, true)` nu dezsetează nici el — lasă tot `''`.

**Nu propune „garda să verifice absența GUC-ului".** S-a măsurat; nu merge.

---

## 4. Politicile, exact așa cum sunt în bază

### Izolarea pe firmă

Pe tabelele de colecții generate de motor:

```sql
CREATE POLICY tenant_isolation ON "zvd_<nume>"
  USING       (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))
  WITH CHECK  (zveltio_tenant_write_ok(tenant_id));
ALTER TABLE "zvd_<nume>" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "zvd_<nume>" FORCE ROW LEVEL SECURITY;
```

Pe tabelele proprii ale extensiilor, forma echivalentă e
`zveltio_tenant_scope_ok(tenant_id)`.

**`FORCE` nu e decorativ.** Fără el, proprietarul tabelei ocolește propriile
politici.

**Marcajul `(SELECT …)` nu e stil.** Un `current_setting()` gol în predicat se
evaluează **per rând**; înfășurat, devine InitPlan, evaluat o dată. Măsurat: de
trei ori diferență. Dacă vezi un predicat fără el, aia e o regresie reală.

### Citirea și scrierea sunt DELIBERAT diferite

```
citire : tenant_id ∈ zveltio_visible_tenants()      — poate fi un subarbore întreg
scriere: tenant_id  = zveltio.current_tenant        — DOAR nodul propriu
```

Un părinte cu `read_scope = 'subtree'` **citește** copiii și **nu scrie** în ei.
Asta e intenționat: consolidarea e o operațiune de citire.

### Ce vede o cerere — `zveltio_visible_tenants()`

```sql
CASE
  WHEN zveltio.visible_tenants e setat  THEN acea listă
  WHEN zveltio.current_tenant e setat   THEN [acea firmă]
  WHEN zveltio.fail_closed_tenant = on  THEN []                    -- niciun rând
  ELSE [firma implicită]                                           -- fail-OPEN
END
```

**Ultima ramură e cea de care trebuie să întrebi.** Fără context, predicatul
rezolvă la firma implicită, deci un cod care ratează contextul citește datele
firmei implicite în loc de nimic. Există `ZVELTIO_FAIL_CLOSED_TENANT=1`, dar e
**oprit implicit**. E o alegere, nu o scăpare — dar e alegerea cea mai atacabilă
din tot modelul, și un audit adversarial ar trebui s-o atace prima.

---

## 5. Ierarhia

`zv_tenants.parent_id`, listă de adiacență, cu trigger anti-ciclu care refuză și
adâncimea peste **64**. Unitățile nu se șterg: `closed_at` + `merged_into`.

Reach-ul unei persoane e pe `zv_tenant_users.read_scope`, cu patru valori:

| `read_scope` | vede |
|---|---|
| `self` | doar firma proprie |
| `list` | o listă explicită de firme |
| `subtree` | firma proprie și tot ce e sub ea |
| `org` | toată organizația |

Sunt **granturi, nu filtre**: cine are și `self`, și `subtree`, are `subtree`.
Ordinea e în `REACH_ORDER` (`tenant-scope.ts`). Se rezolvă **o dată pe cerere**,
ca rolul motorului, înainte de coborârea de privilegii — pentru că
`zv_tenant_users` trebuie citit ca să se afle ce are voie să citească.

---

## 6. Cele DOUĂ lucruri numite „RLS" — cea mai mare sursă de confuzie

Ambele audituri independente de până acum au ajuns aici, pe drumuri diferite.

| | **RLS Postgres** | **regulile de rând ale produsului** |
|---|---|---|
| ce e | politici pe `tenant_id` | rânduri în `zvd_rls_policies` |
| scrise de | motor, la crearea colecției | administratorul firmei, din Studio |
| exemplu | „vezi doar rândurile firmei tale" | „vezi doar ce ai creat tu" |
| aplicate de | Postgres | Postgres **și** motorul |

A doua e un strat de produs care **se compilează** în politici Postgres
RESTRICTIVE, pe lângă filtrarea din motor. Forma generată:

```sql
CREATE POLICY zv_row_rules ON "zvd_<nume>" AS RESTRICTIVE
  USING (<predicat>) WITH CHECK (<predicat>);
```

`RESTRICTIVE` se combină cu ȘI peste politica permisivă de firmă — deci nu poate
lărgi nimic, doar îngusta.

### Aceeași regulă e randată în PATRU locuri

```
applyRlsFilters        WHERE Kysely, pe tabela vie
buildRowRulePredicate  text SQL, ca politică RESTRICTIVE
matchesRlsFilters      JavaScript, în proces, pentru fan-out realtime
rlsJsonConditions      SQL peste instantanee jsonb, pentru `?as_of=`
```

Istoria e relevantă pentru un auditor, fiindcă e clasa de defect care s-a produs
de cele mai multe ori aici:

- un audit independent a găsit **7 divergențe** între primele trei; una era
  scurgere — `neq` pe o coloană NULL: absent din `/api/data`, **livrat prin SSE**;
- al patrulea n-a fost comparat cu nimic până în 31 august 2026. Adăugat la suita
  diferențială, a dat **18 eșecuri din 56 pe cod neschimbat**, dintre care
  douăsprezece erau ACEEAȘI scurgere, încă vie pe `?as_of=`.

**De aceea cei patru nu mai decid nimic.** Semantica stă într-un singur loc,
`lib/tenancy/rule-operators.ts`, și fiecare o randează. Poarta
`check-rule-interpreters` pică dacă apare o a cincea citire scrisă de mână.

Două reguli din acel fișier merită citite înainte de a raporta ceva despre ele,
pentru că sunt contra-intuitive și au fost scrise greșit de mai multe ori:

1. **Comparația e TEXTUALĂ.** Valoarea unei reguli e mereu un șir. Pe o coloană
   întreagă, motorul trimite șirul și Postgres îl convertește, deci `code = '5'`
   se potrivește cu rândul unde code e 5. `5 === '5'` în JavaScript nu.
2. **O valoare lipsă ELIMINĂ rândul, pe fiecare operator, negativele incluse.**
   `NULL <> 'x'` e NULL, nu TRUE, iar un `WHERE` aruncă ce nu poate confirma. Cod
   în memorie care raționează `undefined !== 'x'` **păstrează** un rând pe care
   baza îl ascunde. Aia a fost scurgerea.

### Când se retrage o regulă — per sursă, nu uniform

`getRlsFilters` sare o regulă **doar** dacă valoarea se rezolvă la `null`:

```
user_id     → user.id             ''  NU sare
user_email  → user.email ?? null  absent SARE
user_role   → user.role           ''  NU sare
static:VAL  → VAL
```

Politica generată trebuie să facă identic, altfel cele două straturi spun lucruri
diferite. A făcut greșit până în 31 august: sărea la orice setare goală, deci o
regulă pe `user_role` — adică **orice** regulă pe rol, fiindcă better-auth nu
populează `session.user.role` — avea motorul ascunzând tot și politica arătând
tot. Politica era mai permisivă decât motorul, exact pe stratul care există
pentru handler-ul care și-a uitat filtrele.

### Chei API

O cheie nu e cunoscută când `tenantMiddleware` publică identitatea — se rezolvă
în handler. `validateApiKey` publică actorul ea însăși, **nu apelanții**: există
doi apelanți, iar al doilea (`routes/edge-functions.ts`) folosea rezultatul doar
ca boolean. O cheie poate fi scutită de regulile de rând, per cheie
(`zv_api_keys.rls_bypass`), și scutirea se citește din `zveltio.rls_bypass` — o
decizie publicată, nu o comparație de nume de rol în predicat.

---

## 7. Extensiile

Se încarcă **la nivel de instanță**, într-un singur proces. „Încarcă extensia
doar pentru firma B" nu există și nu e o constatare — activarea per firmă e o
poartă la execuție, nu o încărcare separată.

Traficul `/ext/*` trece prin **același** `tenantMiddleware`. Fără el, un handler
de extensie care folosește `ctx.reqDb(c)` ar cădea pe pool-ul global fără GUC.

Codul de extensie care rulează în worker folosește rolul `zveltio_worker`:
`NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, cu granturi doar pe `zvd_*` și `REVOKE`
explicit pe tabelele de autentificare. Firma e **injectată de gazdă**, nu
declarată de worker. Conexiunile contaminate se închid, nu se întorc în pool.

---

## 8. Ce NU e modelul — corectări pentru presupuneri frecvente

- **Nu e schema-per-tenant.** `provisionTenantSchema` **există și e apelată**
  (`routes/tenants.ts`), dar schema per firmă nu e mecanismul de izolare.
  „E cod mort" e **greșit**; „nu e calea de izolare" e corect.
- **Nu e bază-per-tenant.**
- **`enableRLS` și `applyTenantRLS` nu sunt duplicate moarte** — ambele sunt
  apelate, din locuri diferite (`routes/tenants.ts`, `lib/data/ddl-queue.ts`).
- **`tenantDbMiddleware` chiar e definit și nemontat** (`middleware/tenant-guard.ts`).
  Asta e o observație corectă.
- **Antetul e `x-tenant-slug`**, nu `x-tenant-id`. Un `x-tenant-id` folosit ca
  sursă de adevăr **e** un defect; unul a fost găsit și reparat la instalarea
  extensiilor.
- **God nu e verificat după numele rolului într-un predicat.** A fost, era cod
  mort, e o permisiune acum (`data:view_all`). O comparație cu `'god'` într-un
  predicat ar fi o regresie reală — dar verific-o, nu o presupune.
- **Tabelele de colecții nu au cheie străină pe `tenant_id`.** Corect, și e
  deliberat.
- **`zv_mail_oauth_states` are cheie primară pe `state`, fără `tenant_id`.** E
  legitim: e un nonce anti-CSRF, iar furnizorul OAuth se întoarce doar cu el,
  fără să știe firma. Rândul poartă `tenant_id` și tabela are `FORCE RLS`.

---

## 9. Piste deja măsurate ca false — nu le raporta ca descoperiri

Fiecare a costat deja timp cuiva.

- **„Politicile RLS nu pot folosi indexul"** — FALS. S-a greșit de două ori, în
  direcții opuse. Forma predicatului decide: `= ANY(array)` nu conduce o
  parcurgere ordonată, egalitatea explicită da. **415 → 204 → 129 ms**, măsurat.
- **`broadcastSSE` e cod mort** — nu e. **„mail iframe XSS"** — fals.
- **`session.user.role` e gol** — adevărat, nu e declarat în better-auth. Codul
  care se bazează pe el e mort, nu periculos. **Dar** vezi §6: o regulă pe
  `user_role` cade în cazul ăla, ceea ce a fost un defect real.
- **Twilio, postgis authz** — reparate. **Sesiuni la ștergerea userului, Valkey,
  DLQ webhooks** — închise.

---

## 10. Unde stau invariantele — ca teste, nu ca documentație

```
tests/harness/row-rules-four-interpreters.test.ts   o regulă, patru randări, toată matricea
tests/unit/rule-operators-single-source.test.ts     fiecare randare chiar citește tabelul
tests/harness/row-rules-in-database.test.ts         regulile se aplică cu WHERE-ul UITAT dinadins
tests/harness/god-enforced-by-database.test.ts      god trece PRIN politici, nu pe lângă ele
tests/harness/second-reservation.test.ts            nicio cerere nu ia a doua conexiune
tests/harness/unique-keys-tenant-scoped.test.ts     nicio cheie unică fără tenant_id
tests/harness/*tenant-isolation*.test.ts            pe tabelă și pe rută
```

Afirmațiile pe care merită să încerci să le spargi:

1. O cerere a firmei A nu poate citi și nu poate scrie rânduri ale firmei B —
   **nici dacă handler-ul își uită complet filtrele**.
2. Un `god` e **unul singur pe instanță**, și vede peste firme **prin politici**,
   nu ieșind din ele.
3. O regulă de rând înseamnă **exact același lucru** în toate cele patru randări.
4. O cerere ține **o singură** conexiune.
5. O extensie oprită pentru firma B **nu acționează** pentru B, pe niciuna dintre
   căile prin care poate acționa.
6. Ce nu poate fi exprimat în bază **nu e aplicat pe jumătate** — ori întreg, ori
   deloc, și se spune care.

---

## 11. Cum verifici ce scrie aici

```bash
DB=zv_$(date +%H%M)
psql -U postgres -h localhost -d postgres -c "CREATE DATABASE $DB"
psql -U postgres -h localhost -d $DB -c "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS vector;"

export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/$DB
export ZVELTIO_REGISTRATION_ENABLED=1     # fără el, ~240 de teste pică din alt motiv

bun test packages/engine/src/tests/harness
bun run audit:gates                        # fiecare poartă, dovedită prin plantare
```

**Bază VIRGINĂ, creată în sesiunea curentă.** Nu e igienă, e condiția ca cifrele
să însemne ceva. Măsurat, aceeași revizie de cod:

| bază | rezultat | durată |
|---|---|---|
| folosită, 10 933 de utilizatori strânși | 907 trec / **108 pică** | 783 s |
| creată în acea dimineață | 1025 trec / **0 pică** | **58 s** |

Cele 108 sunt `403` în masă pe rutele de date — **arată exact ca o regresie de
autorizare**. Nu era. Al doilea semnal, la fel de bun: de treisprezece ori mai
lentă.

Și, **înainte de orice rulare lungă**: `pgrep -af "bun test packages"`. O rulare
rămasă dintr-o sesiune anterioară ține baza și strică tot ce măsori după ea, fără
să spună nimic.

### Ce vreau înapoi de la un audit

Pentru fiecare constatare, marchează explicit:

- **EXECUTAT** — am rulat asta și am văzut rezultatul; sau
- **CITIT** — deduc din cod, nu am rulat.

Ambele sunt utile. Confundate, nu. Și **spune și ce ai verificat și e în regulă**,
mai ales din lista de la §10 — un audit care raportează numai probleme nu spune
cât din suprafață a fost atins.

Dacă ceva pare greșit dar testele îl acoperă, **citește testul** înainte de a
raporta: s-ar putea ca testul să fie cel greșit, și aia e o constatare mai bună.
S-a întâmplat de două ori în 31 august.
