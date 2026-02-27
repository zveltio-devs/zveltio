-- Approval Workflows extension — initial schema

CREATE TABLE IF NOT EXISTS zv_approval_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  collection TEXT NOT NULL,
  trigger_field TEXT,
  trigger_value TEXT,
  is_active BOOLEAN DEFAULT true,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_approval_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES zv_approval_workflows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  approver_role TEXT,
  approver_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  deadline_hours INTEGER,
  is_required BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES zv_approval_workflows(id),
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  current_step_id UUID REFERENCES zv_approval_steps(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS zv_approval_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES zv_approval_requests(id) ON DELETE CASCADE,
  step_id UUID NOT NULL REFERENCES zv_approval_steps(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'skipped')),
  decided_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  comment TEXT,
  decided_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_workflows_collection ON zv_approval_workflows(collection);
CREATE INDEX IF NOT EXISTS idx_approval_workflows_active ON zv_approval_workflows(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_approval_steps_workflow ON zv_approval_steps(workflow_id, step_order);
CREATE INDEX IF NOT EXISTS idx_approval_requests_workflow ON zv_approval_requests(workflow_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_collection ON zv_approval_requests(collection, record_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON zv_approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_by ON zv_approval_requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_request ON zv_approval_decisions(request_id);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_by ON zv_approval_decisions(decided_by);

CREATE OR REPLACE FUNCTION update_approval_workflow_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trigger_approval_workflow_updated_at
  BEFORE UPDATE ON zv_approval_workflows
  FOR EACH ROW
  EXECUTE FUNCTION update_approval_workflow_updated_at();
