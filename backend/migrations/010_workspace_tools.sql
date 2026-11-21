CREATE TABLE workspace_library_entries (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('skill','expert','team')),
  name text NOT NULL,
  description text NOT NULL,
  instructions text NOT NULL,
  related_ids uuid[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id)
);
CREATE INDEX workspace_library_browse ON workspace_library_entries (workspace_id,kind,updated_at DESC,id);
CREATE TABLE workspace_library_builtin_state (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  entry_id uuid NOT NULL,
  enabled boolean NOT NULL,
  PRIMARY KEY (workspace_id,entry_id)
);
ALTER TABLE wallets ADD COLUMN task_limit integer CHECK (task_limit >= 0);
CREATE INDEX ledger_settled_tasks ON ledger (workspace_id,account_id) WHERE operation='settle';
CREATE TABLE workspace_feedback (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('issue','suggestion')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id, id),
  FOREIGN KEY (workspace_id,account_id) REFERENCES memberships(workspace_id,account_id)
);
CREATE INDEX workspace_feedback_owner ON workspace_feedback (workspace_id,account_id,created_at DESC,id);
CREATE TABLE task_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('queued','running','provider_pending','retrying','succeeded','failed','cancelled')),
  level text NOT NULL CHECK (level IN ('info','warn','error')),
  attempt integer NOT NULL CHECK (attempt >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_by_task ON task_events (task_id,id DESC);
