CREATE TABLE copywriting_drafts (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  source_task_id uuid REFERENCES tasks(id),
  title text NOT NULL,
  content text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,account_id,id),
  FOREIGN KEY (workspace_id,account_id) REFERENCES memberships(workspace_id,account_id)
);
CREATE INDEX copywriting_drafts_browse ON copywriting_drafts (workspace_id,account_id,updated_at DESC,id);
CREATE UNIQUE INDEX operation_daily_traffic_source ON operation_records (book_id,(details->>'day'),(details->>'channel')) WHERE kind='traffic';
CREATE INDEX operation_report_days ON operation_records (book_id,(details->>'day')) WHERE kind IN ('orders','performance','traffic');
CREATE INDEX tasks_finished_stats ON tasks (workspace_id,updated_at) WHERE state IN ('succeeded','failed');
