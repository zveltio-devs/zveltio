# Ghost DDL — Zero-Downtime Schema Migrations

Zveltio uses a custom **Ghost DDL** algorithm for schema changes on large tables. Inspired by GitHub's [gh-ost](https://github.com/github/gh-ost) and PlanetScale's online DDL, this is a **native PostgreSQL implementation** — no external tooling required.

---

## The Problem: ALTER TABLE Locks Production

Standard `ALTER TABLE` in PostgreSQL acquires an **AccessExclusiveLock** that blocks all reads AND writes until the migration completes. For small tables this is imperceptible (milliseconds). For large tables it means downtime:

| Table Size | Typical ALTER Duration | Impact |
|---|---|---|
| < 10k rows | < 100ms | Negligible |
| 100k rows | 1–5s | Users notice |
| 1M rows | 10–60s | Outage |
| 10M+ rows | Minutes | Hard downtime |

**Zveltio activates Ghost DDL automatically for tables with > 100,000 rows.**

For tables under this threshold, a direct `ALTER TABLE` is used (faster, simpler).

---

## The Algorithm: 4 Steps

```
Original Table ──────────────────────────────────────── New Original
     │                                                       ↑
     │   Step 1: CREATE ghost + changelog trigger            │
     │   Step 2: Batch copy (10k rows at a time) ──────> Ghost Table
     │   Step 3: Apply changelog (mutations during copy) ──> Ghost Table
     └── Step 4: LOCK (ms) → RENAME original→old, ghost→original
```

### Step 1 — Create Ghost Table + Changelog Trigger

```sql
-- Ghost table: identical structure INCLUDING all indexes and constraints
CREATE TABLE _zv_ghost_products (LIKE products INCLUDING ALL);

-- Apply DDL changes on ghost ONLY (original stays untouched)
ALTER TABLE "_zv_ghost_products" ADD COLUMN phone TEXT;
ALTER TABLE "_zv_ghost_products" DROP COLUMN fax;

-- Changelog table: captures all mutations during copy
CREATE TABLE _zv_changelog_products (
  id          BIGSERIAL PRIMARY KEY,
  operation   TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  row_id      TEXT NOT NULL,
  row_data    JSONB,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger on ORIGINAL: every write gets logged to changelog
CREATE TRIGGER "_zv_trg_ghost_products"
AFTER INSERT OR UPDATE OR DELETE ON products
FOR EACH ROW EXECUTE FUNCTION "_zv_trg_ghost_products_fn"();
```

The original table **continues serving all traffic** with no changes.

### Step 2 — Cursor-Based Batch Copy

Data is copied from original to ghost in batches of **10,000 rows**, using cursor-based pagination:

```sql
-- First batch
INSERT INTO _zv_ghost_products
SELECT * FROM products
ORDER BY id
LIMIT 10000
ON CONFLICT (id) DO NOTHING;

-- Subsequent batches (cursor = last copied id)
INSERT INTO _zv_ghost_products
SELECT * FROM products
WHERE id > $lastId
ORDER BY id LIMIT 10000
ON CONFLICT (id) DO NOTHING;
```

A 50ms pause between batches prevents overwhelming the database under production load.

**During this step:** all writes to `products` are captured in `_zv_changelog_products` by the trigger.

### Step 3 — Apply Changelog

After batch copy completes, accumulated changes are replayed on the ghost table:

- `INSERT` / `UPDATE` → `UPSERT` on ghost (full row snapshot from `to_jsonb(NEW)`)
- `DELETE` → `DELETE` from ghost

```sql
-- For each INSERT/UPDATE in changelog:
INSERT INTO _zv_ghost_products (id, name, phone, ...)
VALUES ($row_id, $name, $phone, ...)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, ...;

-- For each DELETE in changelog:
DELETE FROM _zv_ghost_products WHERE id = $row_id;
```

### Step 4 — Atomic Swap (lock ~milliseconds)

This is the only moment where writes are briefly blocked:

```sql
BEGIN;
  -- SHARE ROW EXCLUSIVE: blocks INSERT/UPDATE/DELETE, allows SELECT
  LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE;

  -- Apply any changelog entries that arrived between step 3 and this LOCK
  -- (the "final drain" window)
  -- ... applyChangelog() runs here again ...

  -- Atomic rename
  ALTER TABLE products          RENAME TO _zv_old_products;
  ALTER TABLE _zv_ghost_products RENAME TO products;

  -- Drop trigger (it was on original, now renamed to _zv_old_products)
  DROP TRIGGER "_zv_trg_ghost_products" ON "_zv_old_products";
  DROP FUNCTION "_zv_trg_ghost_products_fn"();
COMMIT;
```

**Reads continue uninterrupted during the lock.** The lock lasts only as long as 3 RENAME operations — typically 1–5 milliseconds.

After 60 seconds, `_zv_old_products` and `_zv_changelog_products` are dropped asynchronously.

---

## Practical Example: Adding a Column to 5M Rows

```
Collection: invoices (5,200,000 rows)
Operation:  Add column "approval_status TEXT DEFAULT 'pending'"

Timeline:
  T+0s    Ghost table created, trigger installed
  T+1s    Batch copy starts: 10k rows/batch, 50ms pause between batches
            ~520 batches × ~0.2s each ≈ ~104s total copy time
  T+105s  Changelog replay: 312 mutations captured during copy, applied in <1s
  T+106s  Atomic swap: LOCK acquired, 3 RENAMEs, LOCK released — ~3ms
  T+106s  Migration complete. invoices table now has approval_status column.
            Zero downtime. All reads served throughout.
  T+166s  _zv_old_invoices and _zv_changelog_invoices dropped in background.
```

---

## Comparison with Directus / Payload

| Feature | Zveltio (Ghost DDL) | Directus | Payload CMS |
|---|---|---|---|
| Method | Ghost table + atomic swap | Direct ALTER TABLE | Direct ALTER TABLE |
| Lock type during migration | SHARE ROW EXCLUSIVE (~ms) | AccessExclusiveLock (full duration) | AccessExclusiveLock (full duration) |
| Reads during migration | ✅ Unblocked | ❌ Blocked | ❌ Blocked |
| Writes during migration | ✅ Captured in changelog | ❌ Blocked | ❌ Blocked |
| Safe for 1M+ rows | ✅ Yes | ❌ Risk of outage | ❌ Risk of outage |
| External tooling | None (native PostgreSQL) | None | None |
| Activation threshold | > 100k rows | N/A | N/A |

---

## Known Limitations

1. **Requires `id` column** — The cursor-based copy and changelog assume each row has an `id` column. All Zveltio-managed collections have this by default. BYOD tables without `id` are skipped (Ghost DDL is not run on unmanaged tables).

2. **JSONB and array columns** — Preserved correctly via `to_jsonb(NEW)` row snapshots in changelog. Tested in stress tests with 1,000+ concurrent mutations.

3. **Foreign key constraints** — Ghost table is created with `INCLUDING ALL` (includes FK constraints). If referenced tables are also being migrated simultaneously, order of execution matters.

4. **Not transactional across multiple tables** — Ghost DDL migrates one table at a time. A migration that touches two related tables is not atomic at the cross-table level.

5. **Concurrent Ghost DDL on the same table** — Not supported. If a second migration is triggered while one is running, it will fail at `CREATE TABLE _zv_ghost_X` (table already exists). The DDL manager serializes migrations per table.

6. **Memory** — Changelog table grows proportionally to write traffic during copy. On extremely high write-load tables (>1,000 writes/sec) during a long copy, the changelog can become large. Monitor `_zv_changelog_<table>` size if this is a concern.

---

## Relevant Files

- Implementation: [`packages/engine/src/lib/ghost-ddl.ts`](../packages/engine/src/lib/ghost-ddl.ts)
- Stress tests: [`packages/engine/src/tests/stress/ghost-ddl.stress.test.ts`](../packages/engine/src/tests/stress/ghost-ddl.stress.test.ts)
- DDL manager (triggers Ghost DDL): [`packages/engine/src/lib/ddl-manager.ts`](../packages/engine/src/lib/ddl-manager.ts)
