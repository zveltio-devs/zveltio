# Tenancy ierarhic — document de design

*Ciornă, 2026-08-26. Ce e sub „Decis" a fost stabilit în discuție; ce e sub
„Deschis" schimbă schema și are nevoie de un răspuns înainte de cod.*

---

## 1. Ce există azi

| element | stare |
|---|---|
| `zv_tenants` | listă **plată**. Coloane: `id, slug, name, plan, status, max_records, max_storage_gb, max_api_calls_day, max_users, billing_email, trial_ends_at, settings`. **Fără `parent_id`.** |
| `zv_tenant_users` | `(id, tenant_id, user_id, role, invited_by, joined_at)`. Un singur rol per pereche. Fără rază, fără valabilitate. |
| predicatul RLS | `zveltio_tenant_scope_ok(row_tenant)` = `row_tenant = current_setting('zveltio.current_tenant')` — **egalitate simplă** |
| autorizare | Casbin, cu firma drept **domeniu** (`addRoleForUser(user, 'tenant_owner', tenantId)`) |
| acoperire | 29 de tabele cu `tenant_id` în baza de bază, 48 cu extensiile instalate |

Coloanele `plan`, `trial_ends_at`, `billing_email`, `max_api_calls_day` spun ce
model a fost construit: **o listă de clienți SaaS care plătesc abonament.**

## 2. De ce nu ajunge

Structura reală, pe exemplul dat: ANSVSA are în subordine 41 de direcții
județene. Fiecare are propriul personal, propria contabilitate, propriul IT.
Contabilitatea ANSVSA trebuie să vadă ce au completat județele; Buzău și
Călărași **nu** trebuie să se vadă între ele.

Cu egalitate simplă, Buzău izolat de Călărași merge. **ANSVSA văzând ambele nu
are cum** — nu există noțiunea de „deasupra". Nu e o setare care lipsește.

Aceeași formă o are orice corporație cu filiale. Nu sunt două cazuri, e unul.

## 3. Modelul

**Unitățile formează un arbore. Ce se configurează nu e arborele, ci raza
fiecărei atribuiri.**

O persoană are una sau mai multe **atribuiri**: *(persoană, unitate, rol,
rază_citire, rază_scriere, valabil_de_la, valabil_până_la)*.

| rază | acoperă | exemplu |
|---|---|---|
| `self` | doar unitatea | contabilul din Buzău |
| `subtree` | unitatea și tot ce e sub ea | contabilitatea ANSVSA |
| `list` | un set explicit | centru de servicii partajate pentru trei fabrici |
| `org` | tot | auditul intern |

**Raza de citire e separată de raza de scriere.** ANSVSA *citește* peste tot
județele, dar înregistrările rămân ale județului. În Postgres asta se exprimă
nativ: `USING` pentru citire, `WITH CHECK` pentru scriere.

**Dimensiunea „departament" nu intră în RLS.** RLS răspunde la *care unități*;
Casbin răspunde la *care resurse*. „Contabilitatea ANSVSA vede contabilitatea
județelor, dar nu resursele umane" e treaba lui Casbin, care are deja domeniu pe
unitate. Cele două înmulțite dau matricea completă.

## 4. Ce se schimbă în cod

Puțin, și asta e vestea bună. `zveltio_tenant_scope_ok` e **prin proiectare**
unicul punct prin care trec toate politicile — ale engine-ului și ale
extensiilor deopotrivă.

1. `zv_tenants` primește `parent_id uuid REFERENCES zv_tenants(id)`.
2. `zv_tenant_users` primește `read_scope`, `write_scope`, `valid_from`,
   `valid_to`.
3. Middleware-ul rezolvă atribuirile o dată pe cerere → mulțimea de unități
   vizibile → GUC.
4. `zveltio_tenant_scope_ok` trece de la egalitate la apartenență la mulțime.
5. Politicile capătă `WITH CHECK` separat de `USING`.

**`tenant_id` de pe rânduri rămâne neatins.** Zero migrații pe cele 48 de tabele.

### Limita de scară
Mulțimea din GUC crește cu arborele. Pentru zeci sau sute de unități e o listă
mică rezolvată o dată pe cerere, cost zero pe rând. Peste câteva mii, trecerea
corectă e la cale materializată (`ltree`) cu potrivire de prefix — **prin aceeași
funcție**, deci decizia se poate amâna.

## 5. Decis

- Arbore de unități, nu listă plată.
- Raze pe atribuire, nu pe utilizator.
- Citire și scriere, raze separate.
- Atribuirea e un **rând**, cu valabilitate în timp — de aici ies gratis
  delegarea, accesul temporar al unui auditor și rolurile matriciale. Costul
  acum e o coloană; costul mai târziu e o migrare peste toate accesele.
- RLS rămâne, în `public` partajat. Schemă-per-unitate ar face raportarea
  consolidată un `UNION` peste N scheme, rupt la fiecare unitate nouă — iar
  consolidarea e chiar cerința.
- Coloanele de abonament (`plan`, `trial_ends_at`, `billing_email`,
  `max_api_calls_day`) ies din `zv_tenants`. O filială n-are abonament;
  abonamentul, dacă există, e al **instanței**.
- **Principalul e polimorf de la început**: persoană | serviciu | instanță
  străină. Federația se adaugă apoi fără rescriere. `zv_api_keys` are deja
  `scopes`, `expires_at`, `casbin_subject` — jumătate din mecanism.
- **`rls_bypass` nu devine niciodată mecanismul federației.**

## 6. Deschis — patru întrebări care schimbă schema

**Î1. Adâncime.** ANSVSA → DSVSA județean → circumscripții locale? Designul e
identic la orice adâncime; întreb doar ca să nu presupun două niveluri și să
descopăr al treilea după.
*Recomandarea mea: arbore de adâncime arbitrară.*

**Î2. Scrie vreodată un nivel superior în datele unui subordonat?** Sau doar
citește și aprobă? Dacă ANSVSA face corecții direct în registrul Buzăului,
`WITH CHECK` trebuie să fie „nodul propriu **sau** un descendent unde am rol de
supervizor", nu doar nodul propriu.
*Recomandarea mea: implicit doar nodul propriu; supervizarea, dacă e nevoie, ca
rază de scriere explicită pe atribuire.*

**Î3. Mediile `prod`/`dev`.** Există deja, ca scheme per firmă. E o a doua
dimensiune, ortogonală pe arbore — are fiecare județ propriul `dev`, sau mediul
e al instanței? Nedecis acum, schemele se înmulțesc singure.
*Recomandarea mea: mediul e al instanței, nu al unității.*

**Î4. Transfer și reorganizare.** Un dosar mutat între județe, două direcții care
fuzionează. Dacă `tenant_id` se **modifică**, istoricul spune că dosarul a fost
dintotdeauna al noii unități.
*Recomandarea mea, pentru instituție publică: proprietatea se versionează, nu se
suprascrie.*

## 7. Explicit în afara modelului

- **Vizibilitate doar pe agregat** („holdingul vede totalul, nu înregistrările").
  RLS e la nivel de rând; nu poate exprima „vezi suma dar nu termenii". Se
  rezolvă cu vederi sau agregate materializate. Scris aici ca să nu încerce
  nimeni să o forțeze în politici.
- **Reședința datelor** (o filială care trebuie să țină datele în altă țară) —
  instanță separată, nu o rază.
- **Rânduri cu doi proprietari.** Un singur `tenant_id` pe rând; coproprietatea
  reală ar cere o tabelă de legătură. Se rezolvă prin direcție: proprietar unic
  la nodul potrivit, vizibil în jos.

## 8. Cum se verifică

Un test care construiește arborele ANSVSA în miniatură — rădăcină, două
județe — și dovedește, pe rânduri reale:

1. Buzău nu vede rândurile Călărașiului.
2. ANSVSA vede rândurile ambelor.
3. ANSVSA **nu poate scrie** în rândurile Buzăului (dacă Î2 rămâne pe
   recomandare).
4. O atribuire expirată nu mai vede nimic.
5. Un rând global e vizibil din toate cele trei.

Testul trebuie să pice pe codul de azi la punctul 2 — e proba că modelul chiar
s-a schimbat.
