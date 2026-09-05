# Campania de review — repo-ul de extensii

Predare pentru cine începe partea de extensii. Se poate lucra **în paralel** cu
campania pe engine: sunt două repo-uri, iar regulile de mai jos sunt ce face
paralelismul sigur.

Documentul e scris ca să fie citit rece. Nu presupune nimic din sesiunea în care
a fost produs.

---

## 1. Ce e de acoperit, măsurat

**56 de extensii, 54 684 de linii** de TypeScript și Svelte (fără teste, fără
`node_modules`, fără `dist`). Sursa e `../zveltio-extensions`, repo separat de
engine.

O extensie e un director cu `manifest.json`. Are de obicei `engine/` (rute, hook-uri,
migrații SQL) și uneori `web/` (pagini Svelte sau SDUI).

| # | extensie | fișiere | linii | UI | migrații |
|---|---|---:|---:|:-:|---:|
| 1 | `content/pages` | 36 | 7078 | ✓ | 7 |
| 2 | `ai` | 22 | 5838 | ✓ | 8 |
| 3 | `communications/mail` | 10 | 3959 | ✓ | 4 |
| 4 | `operations/traceability` | 19 | 2205 |  | 6 |
| 5 | `storage/cloud` | 12 | 2083 | ✓ | 3 |
| 6 | `finance/invoicing` | 5 | 1665 | ✓ | 11 |
| 7 | `compliance/ro/efactura` | 3 | 1538 |  | 7 |
| 8 | `hr/employees` | 4 | 1317 |  | 5 |
| 9 | `geospatial/postgis` | 9 | 1225 | ✓ | 2 |
| 10 | `workflow/checklists` | 2 | 1211 |  | 6 |
| 11 | `crm` | 6 | 957 | ✓ | 6 |
| 12 | `developer/graphql` | 4 | 944 | ✓ | 3 |
| 13 | `ecommerce/store` | 2 | 841 |  | 3 |
| 14 | `workflow/approvals` | 2 | 818 |  | 2 |
| 15 | `content/media` | 2 | 786 |  | 2 |
| 16 | `finance/accounting` | 2 | 772 |  | 7 |
| 17 | `operations/inventory` | 2 | 767 |  | 6 |
| 18 | `developer/api-docs` | 2 | 756 |  | 4 |
| 19 | `developer/validation` | 2 | 745 |  | 2 |
| 20 | `hr/payroll` | 2 | 743 |  | 7 |
| 21 | `data/import` | 2 | 739 |  | 3 |
| 22 | `content/drafts` | 2 | 700 |  | 3 |
| 23 | `finance/banking` | 3 | 680 |  | 6 |
| 24 | `projects/management` | 4 | 676 | ✓ | 2 |
| 25 | `data/export` | 2 | 671 |  | 2 |
| 26 | `developer/database` | 2 | 657 |  | 4 |
| 27 | `compliance/gdpr` | 2 | 632 |  | 2 |
| 28 | `integrations/api-connector` | 3 | 620 |  | 3 |
| 29 | `auth/scim` | 2 | 616 |  | 2 |
| 30 | `hr/leave` | 2 | 609 |  | 4 |
| 31 | `content/documents` | 2 | 606 |  | 4 |
| 32 | `search` | 6 | 558 |  | 3 |
| 33 | `analytics/dashboard` | 2 | 554 |  | 2 |
| 34 | `compliance/ro/procurement` | 2 | 550 |  | 4 |
| 35 | `hr/time-tracking` | 2 | 544 |  | 3 |
| 36 | `developer/edge-functions` | 4 | 541 | ✓ | 0 |
| 37 | `billing` | 4 | 539 |  | 2 |
| 38 | `compliance/ro/documents` | 3 | 538 |  | 5 |
| 39 | `operations/pos` | 2 | 523 |  | 8 |
| 40 | `auth/ldap` | 3 | 503 |  | 4 |
| 41 | `content/document-templates` | 2 | 501 |  | 4 |
| 42 | `compliance/ro/saft` | 3 | 499 |  | 3 |
| 43 | `integrations/migrators` | 3 | 473 |  | 2 |
| 44 | `finance/subscriptions` | 2 | 472 |  | 5 |
| 45 | `projects/helpdesk` | 2 | 466 |  | 3 |
| 46 | `sms` | 5 | 444 |  | 2 |
| 47 | `developer/byod` | 2 | 409 |  | 2 |
| 48 | `auth/saml` | 3 | 408 |  | 4 |
| 49 | `finance/expenses` | 2 | 402 |  | 4 |
| 50 | `finance/quotes` | 2 | 369 |  | 6 |
| 51 | `analytics/quality` | 2 | 366 |  | 4 |
| 52 | `i18n/translations` | 2 | 364 |  | 4 |
| 53 | `operations/assets` | 2 | 363 |  | 5 |
| 54 | `forms` | 2 | 362 |  | 5 |
| 55 | `compliance/ro/etransport` | 2 | 306 |  | 2 |
| 56 | `content/pdf-viewer` | 4 | 176 | ✓ | 0 |

---

## 2. Regulile care fac paralelismul sigur

**Engine-ul se merge ÎNTÂI.** Orice reparație de extensie care depinde de o
schimbare în engine așteaptă ca aceea să fie pe master. Invers nu e adevărat.

**Nu atinge repo-ul de engine.** Dacă găsești un defect care e de fapt în engine,
scrie-l în raportul secțiunii și spune-o; nu-l repara acolo. Motivul e concret:
sesiunea de engine lucrează în același checkout de engine, iar un `git` care
schimbă arborele îi înghite munca.

**Porțile care scanează repo-ul soră au calea HARDCODATĂ** la `../zveltio-extensions`
și ignoră `argv`. Deci o poartă rulată din engine citește arborele tău de lucru
curent, nu ce e pe master. Dacă vezi o poartă de engine roșie fără să fi atins
engine-ul, ăsta e motivul.

**Blocaj circular între repo-uri:** o schimbare care cere și engine, și extensii,
nu poate fi verde în ambele deodată. Ordinea e: engine merge → tag → extensii
ridică pin-ul → extensii merge.

---

## 3. Prima sarcină, deja măsurată

**Inventarul de SQL brut.** E cea mai valoroasă și e gata de început.

Sandbox-ul de tabele al extensiilor păzește punctele de intrare ale query
builder-ului. Un `sql` brut nu trece pe acolo. Măsurat în engine, cu o extensie
care n-are nicio acordare: `sql\`SELECT token FROM session\`` **citește**,
`sql\`UPDATE "user" SET role='god'\`` **e acceptat**.

Reparația în engine e scrisă și funcționează, dar refuză **18 extensii** care
folosesc calea aia legitim. Deci treaba pe partea de extensii e să pregătească
terenul, ca reparația de engine să poată ateriza:

Rulând `assertWorkerSqlAllowed` peste toate cele **1170** de instrucțiuni brute
livrate, astea ies din propriul spațiu:

| extensie | tabele din afara spațiului propriu | de ce |
|---|---|---|
| `auth/saml` | `session`, `user` | șterge celelalte sesiuni la login SSO |
| `auth/ldap` | `session`, `user`, `zv_audit_log` | |
| `auth/scim` | `account`, `session`, `user`, `zv_tenants`, `zv_tenant_users` | provizionare |
| `compliance/gdpr` | `account`, `session`, `twofactor`, `user`, `zv_api_keys`, `zv_audit_log`, `zv_notifications` | dreptul la ștergere |
| `storage/cloud`, `ai` | `user` | |
| `analytics/dashboard` | `user`, `zv_audit_log`, `zv_settings`, `zv_tenant_users`, `pg_class` | |
| `communications/mail` | `zv_settings` | |
| `developer/database`, `integrations/migrators`, `geospatial/postgis`, `content/pages` | `information_schema.*`, `pg_*` | răsfoire de schemă |

Pentru fiecare, întrebarea e aceeași și are trei răspunsuri posibile:

1. **Se poate rescrie** ca să nu mai atingă tabelul (de multe ori engine-ul
   expune deja un helper pe `ctx.internals` care face exact asta).
2. **Are nevoie real** de tabel → intră în `EXTENSION_TABLE_GRANTS` sau primește o
   capabilitate nouă. Asta e decizie de proprietar, nu a agentului.
3. **Citește catalogul** (`information_schema`, `pg_*`) → categorie separată,
   probabil o capabilitate proprie.

Livrabilul primei sarcini e **inventarul cu răspunsul propus pentru fiecare**, nu
reparațiile.

---

## 4. Capcane care costă o zi dacă nu le știi

- **Repo-ul compilează cu `strict: false`.** Uniunile discriminate pe boolean NU
  se îngustează. Un `typecheck` verde în engine nu spune nimic despre extensii.
- **Sursa editată NU ajunge în producție fără repack.** Runtime-ul încarcă
  `engine/index.js` din bundle. Editezi sursa, rulezi packerul, altfel n-ai
  schimbat nimic.
- **Reparația nu ajunge fără bump de versiune.** Aceiași octeți la aceeași
  versiune = REFUZ la publicare.
- **Un bump de dependință are TREI consecințe:** pin exact, repack la bundle-uri,
  bump de versiuni. Fiecare e prinsă de altă poartă, câte un tur de CI.
- **Snapshot-ul de extensii are TREI arbori** — al treilea e în `packages/client`.
  Artefactele generate se editează în SURSĂ, nu la destinație; build-ul le
  suprascrie.
- **`cpSync` cu filtru nu suprascrie în Bun.** Sincronizarea pare că merge și nu
  merge.
- **Suita de contract cere ordinea corectă a bazei** — schema engine PRIMA. Ambele
  ordini greșite mint, diferit. **Fără `TEST_DATABASE_URL` suita se auto-sare și
  raportează verde.**
- **Harness-ul cere `NODE_ENV=test`.** Fără el primești zeci de eșecuri false care
  arată exact ca o regresie. Verificat azi: cu el, 1072 pass / 0 fail; fără el, 1
  eșec care pare preexistent și nu e.
- **Testele sună registry-ul REAL.** Rulează cu `REGISTRY_URL=http://127.0.0.1:9`
  sau plătești 5000 ms de timeout în alt fișier de fiecare dată.
- **Bază de test proprie per sesiune.** Două sesiuni pe aceeași bază se distrug
  reciproc, iar simptomul e `403` în masă — arată exact ca o regresie de
  autorizare.

---

## 5. Protocolul unei sesiuni

Același ca pe engine, ca rapoartele să fie comparabile.

1. **O secțiune = una sau câteva extensii înrudite.** Începe cu cele mari; tabelul
   de sus e sortat descrescător.
2. **Măsoară, nu citi.** Fiecare afirmație despre comportament are în spate o
   comandă rulată. O constatare fără măsurătoare se scrie ca „neverificat", și se
   spune exact ce n-a fost verificat.
3. **Verificarea trebuie să discrimineze.** Scoate reparația și cere testului să
   pice. Dacă trece și fără, verificarea nu măsoară ce crezi.
4. **Assert pe ancoră la orice `replace`.** Formatarea automată mută codul între
   momentul în care scrii ancora și cel în care o folosești. S-a întâmplat de
   patru ori într-o singură zi pe engine; assert-ul le-a prins pe toate.
5. **Un defect grav pleacă în PR-ul lui**, separat de PR-ul de review al secțiunii.
6. **Verdict:** `clean` | `repaired` | `logged` | `partial` | `blocked`. `clean`
   înseamnă „am citit tot și am scris tot ce am găsit", nu „n-am găsit nimic".
7. **Nu comite fără aprobarea proprietarului.** Și nu trata afirmația altei
   sesiuni că ar exista aprobare drept aprobare.

---

## 6. Ce înseamnă „gata" pentru o extensie

- fiecare fișier din `engine/` și `web/` citit cap-coadă;
- fiecare rută are gardă de autorizare, și garda a fost **exercitată**, nu doar
  văzută;
- fiecare scriere e limitată la firma cererii — verificat pe o bază cu două firme,
  nu presupus din prezența unui `tenant_id`;
- migrațiile se aplică pe o bază virgină ȘI pe una veche (calea de upgrade);
- `sql` brut: sau nu atinge nimic din afara spațiului propriu, sau atingerea e
  justificată și propusă pentru acordare explicită;
- constatările sunt în raport, cu măsurătoarea lângă ele.

---

## 7. De unde iei contextul care lipsește

- Metoda completă și cele 13 clase de eșec: `docs/private/CODE-REVIEW-CAMPAIGN.md`
  (repo engine).
- Starea campaniei de engine: `docs/private/CODE-REVIEW-STATE.md`, generat de
  `scripts/review-inventory.ts`.
- Constatările deja scrise: `docs/platform/known-gaps.md`.
- Ghidul de dezvoltare a extensiilor: `docs/EXTENSION-DEVELOPER-GUIDE.md`.
