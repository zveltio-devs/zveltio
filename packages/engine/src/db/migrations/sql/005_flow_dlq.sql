-- Migration: 005_flow_dlq
--
-- Adds the missing zv_flow_dlq (Dead Letter Queue) table that
-- routes/flows.ts has been reading + writing all along.
--
-- The DbSchema interface declared ZvFlowDlqTable so Kysely typecheck
-- passed, but no migration ever created the physical table. The DLQ
-- handlers (`GET /api/flows/dlq`, `POST /api/flows/dlq/:id/retry`) and
-- the executor's failure-path INSERTs would 500 at runtime against a
-- real Postgres. As with most extension routes, these failures were
-- wrapped in implicit `.catch()` chains or just bubbled up as 500s
-- the operator never read.

CREATE TABLE IF NOT EXISTS zv_flow_dlq (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id      UUID        NOT NULL REFERENCES zv_flows(id) ON DELETE CASCADE,
  payload      JSONB       NOT NULL DEFAULT '{}',
  error        TEXT,
  attempt_count INTEGER     NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_flow_dlq_flow ON zv_flow_dlq(flow_id, created_at DESC);
