-- Every audit log entry ever written stored its metadata as a JSON string, not
-- a JSON object.
--
-- `auditLog` interpolated `JSON.stringify(metadata)` and cast it `::jsonb`. The
-- driver already sends that parameter as jsonb, so the cast is a no-op and
-- Postgres stored the serialized text AS a jsonb string scalar: the whole
-- object wrapped in quotes, its own quotes escaped.
--
-- The consequence is not cosmetic. `metadata->>'outcome'` answers NULL on every
-- such row, and so does every other key. Nobody could filter the audit trail by
-- what happened, count failed attempts, or alert on a pattern — the log was
-- readable by a person scrolling it and queryable by no one. That is most of
-- what an audit trail is for, and it failed silently: the rows are there, they
-- look right, and the query returns nothing.
--
-- The write is fixed in lib/audit.ts (`::text::jsonb`). This repairs what is
-- already stored.
--
-- `#>> '{}'` extracts a jsonb scalar as text — the inverse of the mistake —
-- and the result is re-parsed. Guarded on `jsonb_typeof = 'string'` so it
-- touches only the damaged rows and can be re-run safely: rows already objects
-- are skipped, and rows repaired by an earlier run are objects.

UPDATE zv_audit_log
SET metadata = (metadata #>> '{}')::jsonb
WHERE jsonb_typeof(metadata) = 'string'
  -- A metadata value that is *legitimately* a string would be destroyed by
  -- re-parsing, so only touch what parses as an object. Nothing writes a bare
  -- string today, but this migration will outlive that assumption.
  AND (metadata #>> '{}') LIKE '{%';

-- DOWN
-- Not reversible, and should not be. Reverting would mean re-breaking the
-- column, and any row written after this migration is a genuine object that
-- would be indistinguishable from a repaired one.
