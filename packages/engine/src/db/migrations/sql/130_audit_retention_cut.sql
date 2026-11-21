-- 130_audit_retention_cut.sql
--
-- ADR 0060 decision 4: the retention window per tenant, and the purge cutting
-- each tenant's hash chain from the oldest end and recording the new genesis.
--
-- THE WINDOW PER TENANT. 128's policies let `zveltio_audit_purge` delete any
-- row older than the window it publishes, every tenant's alike. The window now
-- belongs to one chain at a time: the purge also publishes
-- `zveltio.audit_purge_tenant` (a tenant id, or `instance` for the instance's
-- own rows), and the database lets it read and delete only that chain's rows
-- older than the window. The engine purges one chain per transaction, each with
-- its own window: `AUDIT_LOG_RETENTION_DAYS`, or the tenant's entry in
-- `AUDIT_LOG_RETENTION_TENANT_DAYS` (lib/runtime/garbage-collector.ts).
--
-- THE CUT. Before this, a purged row's chain entry stayed and verify counted
-- rows missing at the oldest end as purged — so did rows the owner deleted
-- there with the append-only trigger off. Now a statement trigger runs after
-- every DELETE on `zv_audit_log` that the append-only trigger let through,
-- which only the purge role's can be. Per chain, the deleted rows must be its
-- oldest entries, contiguous from the current genesis; anything else is refused
-- and the DELETE with it. The trigger then appends the new genesis — the last
-- cut entry's seq and hash — to `zv_audit_chain_cut` and deletes the cut
-- entries. Verify walks each chain from its latest genesis, and any row missing
-- after it is a break, at the oldest end too. A DELETE made with the
-- append-only trigger off (DDL) cuts nothing: the rows are missing inside the
-- chain and verify says so.
--
-- `zv_audit_chain_cut` is append-only like the chain: one row per cut, ids and
-- hashes only. An entry of `zv_audit_chain` may be deleted only once a genesis
-- covers it, which is what the cut does; the request role holds nothing on
-- either table, and the purge role may read the chain (ids and hashes) to find
-- the oldest end.
--
-- A chain cut to its last entry continues from its genesis, not from seq 1.
--
-- DDL only, before any audit write (55006). Re-runnable.

CREATE TABLE IF NOT EXISTS zv_audit_chain_cut (
  tenant_id uuid,
  seq       bigint NOT NULL,
  hash      bytea NOT NULL,
  cut_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT zv_audit_chain_cut_tenant_seq UNIQUE NULLS NOT DISTINCT (tenant_id, seq)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zveltio_rls') THEN
    REVOKE ALL ON zv_audit_chain_cut FROM zveltio_rls;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zveltio_audit_purge') THEN
    GRANT SELECT ON zv_audit_chain TO zveltio_audit_purge;
  END IF;
END
$$;

DROP POLICY IF EXISTS audit_log_purge_read ON zv_audit_log;
CREATE POLICY audit_log_purge_read ON zv_audit_log FOR SELECT
  USING (current_user = 'zveltio_audit_purge'
         AND coalesce(tenant_id::text, 'instance') = current_setting('zveltio.audit_purge_tenant', true)
         AND created_at < now() - make_interval(
               days => NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int)
         AND NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int >= 1);

DROP POLICY IF EXISTS audit_log_purge ON zv_audit_log;
CREATE POLICY audit_log_purge ON zv_audit_log FOR DELETE
  USING (current_user = 'zveltio_audit_purge'
         AND coalesce(tenant_id::text, 'instance') = current_setting('zveltio.audit_purge_tenant', true)
         AND created_at < now() - make_interval(
               days => NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int)
         AND NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int >= 1);

DROP POLICY IF EXISTS audit_log_purge_expired_only ON zv_audit_log;
CREATE POLICY audit_log_purge_expired_only ON zv_audit_log AS RESTRICTIVE FOR DELETE
  USING (current_user <> 'zveltio_audit_purge'
         OR (coalesce(tenant_id::text, 'instance') = current_setting('zveltio.audit_purge_tenant', true)
             AND created_at < now() - make_interval(
               days => NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int)
             AND NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int >= 1));

-- 129's, continuing from the latest genesis when every entry was cut.
CREATE OR REPLACE FUNCTION zveltio_audit_chain_link(r zv_audit_log) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
  IF prev_seq IS NULL THEN
    SELECT k.seq, k.hash INTO prev_seq, prev_hash FROM zv_audit_chain_cut k
     WHERE k.tenant_id IS NOT DISTINCT FROM r.tenant_id ORDER BY k.seq DESC LIMIT 1;
  END IF;
  INSERT INTO zv_audit_chain (audit_id, tenant_id, seq, content_hash, hash)
  VALUES (r.id, r.tenant_id, coalesce(prev_seq, 0) + 1, content,
          sha256(coalesce(prev_hash, decode(repeat('00', 32), 'hex')) || content));
END
$$;
REVOKE EXECUTE ON FUNCTION zveltio_audit_chain_link(zv_audit_log) FROM PUBLIC;

-- 129's, plus: a chain entry a genesis already covers may go (the cut below).
CREATE OR REPLACE FUNCTION zveltio_audit_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'zv_audit_log'
     AND current_user = 'zveltio_audit_purge' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'zv_audit_chain'
     AND OLD.seq <= (SELECT max(k.seq) FROM zv_audit_chain_cut k
                      WHERE k.tenant_id IS NOT DISTINCT FROM OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (ADR 0060): % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- SECURITY DEFINER: the purge role holds nothing on the chain's writes.
CREATE OR REPLACE FUNCTION zveltio_audit_chain_cut() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  t       record;
  genesis bigint;
BEGIN
  -- Only a DELETE the append-only trigger let through cuts: the purge role's.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'zv_audit_log'::regclass
                    AND tgname = 'zv_audit_log_append_only' AND tgenabled IN ('O', 'A')) THEN
    RETURN NULL;
  END IF;
  FOR t IN
    SELECT c.tenant_id, count(*) AS n, min(c.seq) AS first, max(c.seq) AS last
      FROM gone o JOIN zv_audit_chain c ON c.audit_id = o.id
     GROUP BY c.tenant_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('zveltio:audit-chain:' || coalesce(t.tenant_id::text, '')));
    SELECT coalesce(max(k.seq), 0) INTO genesis FROM zv_audit_chain_cut k
     WHERE k.tenant_id IS NOT DISTINCT FROM t.tenant_id;
    IF t.first <> genesis + 1 OR t.last <> genesis + t.n THEN
      RAISE EXCEPTION 'zv_audit_log: the purge cuts a chain from its oldest end only (ADR 0060): tenant %, rows at seq % to %, genesis %',
        coalesce(t.tenant_id::text, 'instance'), t.first, t.last, genesis
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO zv_audit_chain_cut (tenant_id, seq, hash)
    SELECT c.tenant_id, c.seq, c.hash FROM gone o JOIN zv_audit_chain c ON c.audit_id = o.id
     WHERE c.seq = t.last AND c.tenant_id IS NOT DISTINCT FROM t.tenant_id;
    DELETE FROM zv_audit_chain c USING gone o
     WHERE c.audit_id = o.id AND c.tenant_id IS NOT DISTINCT FROM t.tenant_id;
  END LOOP;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS zv_audit_log_cut ON zv_audit_log;
CREATE TRIGGER zv_audit_log_cut AFTER DELETE ON zv_audit_log
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION zveltio_audit_chain_cut();

DROP TRIGGER IF EXISTS zv_audit_chain_cut_append_only ON zv_audit_chain_cut;
CREATE TRIGGER zv_audit_chain_cut_append_only BEFORE UPDATE OR DELETE ON zv_audit_chain_cut
  FOR EACH ROW EXECUTE FUNCTION zveltio_audit_append_only();
DROP TRIGGER IF EXISTS zv_audit_chain_cut_no_truncate ON zv_audit_chain_cut;
CREATE TRIGGER zv_audit_chain_cut_no_truncate BEFORE TRUNCATE ON zv_audit_chain_cut
  FOR EACH STATEMENT EXECUTE FUNCTION zveltio_audit_append_only();

-- DOWN
-- A chain already cut does not survive the way down: 129's link restarts an
-- emptied chain at seq 1, and its verify counts the cut entries as a gap.

DROP TRIGGER IF EXISTS zv_audit_log_cut ON zv_audit_log;
DROP FUNCTION IF EXISTS zveltio_audit_chain_cut();
DROP TABLE IF EXISTS zv_audit_chain_cut;

CREATE OR REPLACE FUNCTION zveltio_audit_chain_link(r zv_audit_log) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zveltio_audit_purge') THEN
    REVOKE SELECT ON zv_audit_chain FROM zveltio_audit_purge;
  END IF;
END
$$;

DROP POLICY IF EXISTS audit_log_purge_read ON zv_audit_log;
CREATE POLICY audit_log_purge_read ON zv_audit_log FOR SELECT
  USING (current_user = 'zveltio_audit_purge'
         AND created_at < now() - make_interval(
               days => NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int)
         AND NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int >= 1);

DROP POLICY IF EXISTS audit_log_purge ON zv_audit_log;
CREATE POLICY audit_log_purge ON zv_audit_log FOR DELETE
  USING (current_user = 'zveltio_audit_purge'
         AND created_at < now() - make_interval(
               days => NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int)
         AND NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int >= 1);

DROP POLICY IF EXISTS audit_log_purge_expired_only ON zv_audit_log;
CREATE POLICY audit_log_purge_expired_only ON zv_audit_log AS RESTRICTIVE FOR DELETE
  USING (current_user <> 'zveltio_audit_purge'
         OR (created_at < now() - make_interval(
               days => NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int)
             AND NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int >= 1));
