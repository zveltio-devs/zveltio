# Brief pentru refactorizarea identității și a regulilor de rând

Scris pentru cineva care nu cunoaște codul. Urmează auditului din
`docs/private/REVIEW-BRIEF-MULTITENANCY.md` și raportului
`docs/private/AUDIT-MULTITENANCY-ENGINE-VS-DB.md` — citește-le pe ambele întâi.
Scopul nu e „curățenie generală", ci **patru ținte precise care elimină clase
întregi de divergențe**, cu comportament conservat în rest.

---

## 1. De unde plecăm

Auditul independent a găsit 7 divergențe între motor și politicile Postgres.
Una e deja reparată (`matchesRlsFilters` aruncă NULL la `neq`/`not_in`), iar
acordul celor trei interpretori ai unei reguli este acum **păzit de o suită
exhaustivă verde**:

```
packages/engine/src/tests/harness/row-rules-three-interpreters.test.ts   56/56 verde
```

Toate cele 7 constatări au aceeași rădăcină, și anume duplicarea:

- regula de rând e interpretată de **trei implementări** (`applyRlsFilters` în
  Kysely, `buildRowRulePredicate` în generatorul de politici, `matchesRlsFilters`
  în JS pentru realtime/time-travel);
- identitatea apelantului e **construită în cel puțin 4 locuri**, fiecare cu
  forma ei: middleware-ul (`middleware/tenant.ts` — sesiuni, `role: ''`),
  pseudo-userul cheilor API (`lib/data/auth.ts`), `syncUser()` (`routes/sync.ts`
  — rezolvă rolul!), `asUser()` în teste;
- preambulul handler-elor de scriere e copiat de trei ori, cu comentariul
  „MUST mirror" (`lib/data/handlers/single.ts:323`).

Refactorizarea și repararea sunt **aceeași lucrare**: cele trei copii devin una.

---

## 2. Regula de aur

**Nicio schimbare de comportament observabil în afara țintelor de mai jos.**
Toate suitele din `src/tests/harness` trebuie să fie verzi după fiecare pas,
nu doar la final. Fiecare țintă = un commit separat. Dacă o țintă nu poate fi
făcută fără o schimbare de comportament neprevăzută, **oprește-te și raportează**,
nu decide singur.

---

## 3. Ținta 1 — un singur „identity shaper"

**Problema (constatările 1 și 2 din audit, ambele reproduse executabil):**
middleware-ul publică `zveltio.user_role = ''` pentru sesiuni pentru că
better-auth nu populează `session.user.role`; politica generată sare regula
(`nullif('', '') IS NULL`), motorul leagă `undefined` → zero rânduri în tăcere
pe REST, iar `sync.ts:37` rezolvă rolul separat → trei semantici pentru o
regulă `user_role`. Pentru chei API nu se publică **niciun** GUC de identitate
(`tenant.ts:221-222`) → nicio regulă nu există la nivel de bază pentru ele.

**Ce se cere:**
- O singură funcție (modul nou, ex. `lib/tenancy/actor.ts`) care produce forma
  canonică a actorului: `{ id, email, role, roles, kind: 'session' | 'api_key' | 'anonymous', exempt }`.
  Folosită de middleware, de `lib/data/auth.ts`, de `sync.ts` și de teste.
- Rolul se rezolvă **o dată per cerere** (`resolveUserRole`), nu în trei locuri.
- Cheile API primesc identitate: forma `apikey:<uuid>` pe care motorul o folosește
  deja trebuie publicată și în GUC-uri, astfel încât politicile să le vadă.
- Identitățile din teste se importă din shaper, nu se inventează (suita
  three-interpreters are deja forma corectă de sesiune — păstrează-o ca referință).

**Criteriu de acceptare:** pentru o regulă `bucket = user_role`, REST, sync și
politica din bază întorc aceleași rânduri; pentru o regulă `created_by = user_id`
și o cheie API fără `rlsBypass`, baza aplică regula (un SELECT cu WHERE uitat
nu mai întoarce nimic). Adaugă teste harness care demonstrează ambele.

**Atenție:** forma publicată în GUC-uri trebuie să rămână compatibilă cu
predicatele generate existente până la ținta 2 — nu schimba schema GUC-urilor
în această țintă, doar **valorile** puse în ele.

---

## 4. Ținta 2 — un singur compilator de predicat

**Problema:** cei trei interpretori au derivat deja o dată (constatarea 3:
`neq` pe NULL arăta rândul pe SSE deși REST îl ascundea). Suita
three-interpreters îi ține aliniați azi, dar prin supraveghere, nu prin
construcție.

**Ce se cere:**
- Un singur compilator care din AST-ul regulii (`RowRule`) produce predicatul,
  consumat de toate cele trei puncte de utilizare:
  - `applyRlsFilters` (Kysely) — poate primi fragmentul SQL compilat cu parametri;
  - `buildRowRulePredicate` (CREATE POLICY) — același fragment, cu literali
    inline (politicile nu acceptă parametri — un singur escaper, partajat);
  - `matchesRlsFilters` — **eliminat ca interpretor**. Cei doi consumatori
    (broadcast SSE `routes/realtime.ts`, time-travel `single.ts:101`) evaluează
    predicatul în Postgres: `SELECT id FROM (VALUES (...)) WHERE <predicat>`,
    batch-abil per eveniment. Doar Postgres știe ce înseamnă `neq` pe NULL.
- Evaluarea în DB pentru SSE trebuie să aibă un prag de batch (un SELECT pentru
  N rânduri, nu N SELECT-uri) și un comportament explicit la eroare DB
  (fail-closed: evenimentul nu se trimite, plus log).

**Criteriu de acceptare:** `matchesRlsFilters` dispare sau devine un wrapper
subțire peste evaluarea DB; suita three-interpreters rămâne verde **nemodificată**
(și orice schimbare necesară în ea se justifică separat în raport).

**Atenție:** `matchesRlsFilters` mai este folosit și pe calea time-travel din
list; verifică TOȚI apelanții cu grep înainte de a schimba semnătura.

---

## 5. Ținta 3 — preambul comun în write-pipeline

**Problema:** `createRecord` / `patchRecord` / `deleteRecord` din
`lib/data/handlers/single.ts` repetă același lanț (virtual config →
colecție → column access → entity access → RLS → hook-uri), iar
`single.ts:323` mărturisește „MUST mirror createRecord/patchRecord". Fiecare
derapaj al oglinzirii a fost istoric un bug (comentariile din fișier sunt
necrologurile lor).

**Ce se cere:** lanțul comun se extrage în `lib/data/write-pipeline.ts`
(care există deja — continuă-l), iar handler-ele primesc doar partea specifică.
Comentariile „MUST mirror" dispar **prin construcție**, nu prin încă unul.

**Criteriu de acceptare:** suitele harness de data (`data-list-rls-*`,
create/update/delete, bulk) verzi; nicio linie de comportament schimbată;
diff-ul e aproape exclusiv mutare de cod.

**Atenție:** `bulk.ts` are aceeași structură — dacă extragerea se aplică și
acolo fără schimbare de comportament, bine; dacă nu, notează și lasă.

---

## 6. Ținta 4 — fail-closed la identitate lipsă pe colecții cu reguli

**Problema (constatările 1+2 ca clasă):** azi, o regulă a cărei valoare nu se
rezolvă (identitate `''`/lipsă) este **sărită** — fail-open. Corect este:
- colecție **fără reguli** → deschis (trafic public, anonim — neschimbat);
- colecție **cu reguli** + actor fără identitate → **deny**, cu log.

**Ce se cere:** schimbarea în generatorul de politici (garda devine deny la
identitate lipsă) + echivalentul în motor. Depinde de ținta 1 (altfel cheile
API și sesiunile ar fi deny peste tot — ele trebuie întâi să **aibă**
identitate).

**Criteriu de acceptare:** test harness: regulă activă + cerere anonimă →
zero rânduri **și** eveniment de log; cerere cu sesiune/cheie → regula aplicată
normal. Ruta admin RLS trebuie să prevină salvarea unei reguli pe o colecție
destinată traficului public (sau să avertizeze explicit — decizie de documentat
în raport).

**Atenție:** aceasta SINGURA țintă schimbă comportament observabil în mod
intenționat. Verifică toate căile anonime legitime (rute publice, share links,
webhook-uri) ÎNAINTE de a o activa global; dacă există astfel de căi pe
colecții cu reguli, propune un flag per colecție în loc de flip global.
