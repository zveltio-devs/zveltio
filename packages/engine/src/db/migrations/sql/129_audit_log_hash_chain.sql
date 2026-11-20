-- 129_audit_log_hash_chain.sql
--
-- ADR 0060 decision 3: a SHA-256 hash chain per tenant over `zv_audit_log`, and
-- the table owner bound like every other role.
--
-- THE CHAIN. `zv_audit_chain` holds one entry per audit row: the row's id, its
-- tenant (NULL = the instance's own chain), its position `seq` (1, 2, … per
-- tenant), `content_hash` = SHA-256 of the row's canonical form, and
-- `hash` = SHA-256(previous entry's hash || content_hash), the genesis being 32
-- zero bytes. Ids and hashes only: no personal data is copied into the chain.
--
-- The canonical form (`zveltio_audit_content_hash`) is the jsonb text of
--   [1, id, event_type, user_id, resource_id, resource_type, metadata, ip,
--    created_at as UTC with microseconds ("YYYY-MM-DDTHH:MI:SS.US" + "Z"), tenant_id]
-- `1` is the form's version. jsonb text output is normalized (keys sorted, no
-- duplicates, fixed spacing), uuid text is lower case, and the timestamp is
-- spelled without the session's TimeZone or DateStyle — so the same row hashes
-- the same in every session. A column added later is not covered until a new
-- form version names it.
--
-- WHEN AND UNDER WHICH LOCK. A deferred constraint trigger links each new row at
-- COMMIT, under a transaction advisory lock keyed on the tenant: inserts into one
-- tenant's chain serialize, other tenants' do not wait. Deferred, not BEFORE
-- INSERT: a lock taken at the INSERT would be held for the rest of the request
-- transaction — across every await of the engine, so a second connection of the
-- same process appending to the same tenant would wait on a transaction that
-- waits on it, which Postgres cannot see as a deadlock. At COMMIT nothing is
-- awaited any more; the lock lives for the commit alone. A rolled-back insert
-- never reaches the chain. Under REPEATABLE READ (the engine uses none) a
-- concurrent commit would make the head read stale: the unique (tenant_id, seq)
-- refuses the COMMIT rather than forking the chain. A transaction that inserted
-- an audit row holds a pending trigger event until COMMIT, and Postgres refuses
-- ALTER TABLE zv_audit_log in it meanwhile (55006): DDL on the table goes first.
--
-- The trigger function is SECURITY DEFINER (the migration's role, the table
-- owner): `zveltio_rls` appends audit rows and holds no privilege on the chain.
--
-- EXISTING ROWS are chained here, per tenant in (created_at, id) order: the
-- chain proves nothing was changed after this migration, not before it. RLS is
-- lifted from the owner for that read (NO FORCE, restored below, all inside this
-- migration's transaction, which holds the table's ACCESS EXCLUSIVE lock), so a
-- purged tenant's rows — kept until retention — are chained too. Measured: about
-- 35 000 rows a second (100 000 in 2.9 s), the table locked meanwhile.
--
-- THE OWNER BOUND. 128 left the owner every privilege. A trigger now refuses
-- UPDATE, DELETE and TRUNCATE on `zv_audit_log` and `zv_audit_chain` to every
-- role, superuser included; the one exception is a DELETE on `zv_audit_log` by
-- `zveltio_audit_purge`, which 128's policies hold to expired rows. A trigger
-- rather than restrictive policies: RLS binds neither a superuser nor TRUNCATE.
-- The owner can still switch the trigger off; that is DDL, and the chain is
-- what shows its effect (GET /api/admin/audit/verify).
--
-- RETENTION (s4) AND ANCHOR (s5). The purge deletes audit rows and leaves their
-- chain entries: verify still checks every link and reports the rows missing at
-- the oldest end as purged. s4 cuts those entries and records the new genesis;
-- s5 writes each tenant's head (seq, hash) outside the database.
--
-- Re-runnable.

-- First, so no insert lands between the backfill and the trigger.
ALTER TABLE zv_audit_log NO FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS zv_audit_chain (
  audit_id     uuid PRIMARY KEY,
  tenant_id    uuid,
  seq          bigint NOT NULL,
  content_hash bytea NOT NULL,
  hash         bytea NOT NULL,
  CONSTRAINT zv_audit_chain_tenant_seq UNIQUE NULLS NOT DISTINCT (tenant_id, seq)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zveltio_rls') THEN
    REVOKE ALL ON zv_audit_chain FROM zveltio_rls;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION zveltio_audit_content_hash(r zv_audit_log) RETURNS bytea
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT sha256(convert_to(jsonb_build_array(
    1, r.id, r.event_type, r.user_id, r.resource_id, r.resource_type, r.metadata, r.ip,
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    r.tenant_id)::text, 'UTF8'))
$$;

-- Appends `r` to its tenant's chain. The caller holds the tenant's lock (or the
-- table's, in the backfill). Not SECURITY DEFINER, and not executable by PUBLIC:
-- only the trigger below, running as the owner, reaches the chain through it.
CREATE OR REPLACE FUNCTION zveltio_audit_chain_link(r zv_audit_log) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  prev_seq  bigint;
  prev_hash bytea;
  content   bytea := zveltio_audit_content_hash(r);
BEGIN
  IF r.tenant_id IS NULL THEN
    SELECT c.seq, c.hash INTO prev_seq, prev_hash FROM zv_audit_chain c
     WHERE c.tenant_id IS NULL ORDER BY c.seq DESC LIMIT 1;
  ELSE
    SELECT c.seq, c.hash INTO prev_seq, prev_hash FROM zv_audit_chain c
     WHERE c.tenant_id = r.tenant_id ORDER BY c.seq DESC LIMIT 1;
  END IF;
  INSERT INTO zv_audit_chain (audit_id, tenant_id, seq, content_hash, hash)
  VALUES (r.id, r.tenant_id, coalesce(prev_seq, 0) + 1, content,
          sha256(coalesce(prev_hash, decode(repeat('00', 32), 'hex')) || content));
END
$$;
REVOKE EXECUTE ON FUNCTION zveltio_audit_chain_link(zv_audit_log) FROM PUBLIC;

CREATE OR REPLACE FUNCTION zveltio_audit_chain_seal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('zveltio:audit-chain:' || coalesce(NEW.tenant_id::text, '')));
  PERFORM zveltio_audit_chain_link(NEW);
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION zveltio_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'zv_audit_log'
     AND current_user = 'zveltio_audit_purge' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (ADR 0060): % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

DROP TRIGGER IF EXISTS zv_audit_log_chain ON zv_audit_log;
CREATE CONSTRAINT TRIGGER zv_audit_log_chain AFTER INSERT ON zv_audit_log
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zveltio_audit_chain_seal();

DROP TRIGGER IF EXISTS zv_audit_log_append_only ON zv_audit_log;
CREATE TRIGGER zv_audit_log_append_only BEFORE UPDATE OR DELETE ON zv_audit_log
  FOR EACH ROW EXECUTE FUNCTION zveltio_audit_append_only();
DROP TRIGGER IF EXISTS zv_audit_log_no_truncate ON zv_audit_log;
CREATE TRIGGER zv_audit_log_no_truncate BEFORE TRUNCATE ON zv_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION zveltio_audit_append_only();

DROP TRIGGER IF EXISTS zv_audit_chain_append_only ON zv_audit_chain;
CREATE TRIGGER zv_audit_chain_append_only BEFORE UPDATE OR DELETE ON zv_audit_chain
  FOR EACH ROW EXECUTE FUNCTION zveltio_audit_append_only();
DROP TRIGGER IF EXISTS zv_audit_chain_no_truncate ON zv_audit_chain;
CREATE TRIGGER zv_audit_chain_no_truncate BEFORE TRUNCATE ON zv_audit_chain
  FOR EACH STATEMENT EXECUTE FUNCTION zveltio_audit_append_only();

DO $$
DECLARE r zv_audit_log;
BEGIN
  FOR r IN
    SELECT a.* FROM zv_audit_log a
     WHERE NOT EXISTS (SELECT 1 FROM zv_audit_chain c WHERE c.audit_id = a.id)
     ORDER BY a.tenant_id NULLS FIRST, a.created_at, a.id
  LOOP
    PERFORM zveltio_audit_chain_link(r);
  END LOOP;
END
$$;

ALTER TABLE zv_audit_log FORCE ROW LEVEL SECURITY;

-- DOWN

DROP TRIGGER IF EXISTS zv_audit_log_chain ON zv_audit_log;
DROP TRIGGER IF EXISTS zv_audit_log_append_only ON zv_audit_log;
DROP TRIGGER IF EXISTS zv_audit_log_no_truncate ON zv_audit_log;
DROP TABLE IF EXISTS zv_audit_chain;
DROP FUNCTION IF EXISTS zveltio_audit_chain_seal();
DROP FUNCTION IF EXISTS zveltio_audit_append_only();
DROP FUNCTION IF EXISTS zveltio_audit_chain_link(zv_audit_log);
DROP FUNCTION IF EXISTS zveltio_audit_content_hash(zv_audit_log);
