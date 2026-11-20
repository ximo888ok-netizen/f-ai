
CREATE TABLE schedules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  run_at timestamptz NOT NULL,
  request jsonb NOT NULL,
  request_hash text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'submitted', 'failed', 'cancelled')),
  task_id uuid REFERENCES tasks(id),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES memberships(workspace_id, account_id),
  UNIQUE (workspace_id, account_id, idempotency_key),
  CHECK ((state = 'submitted') = (task_id IS NOT NULL))
);
CREATE INDEX schedules_due ON schedules (run_at, id) WHERE state = 'pending';
CREATE INDEX schedules_account ON schedules (workspace_id, account_id, created_at DESC);
