CREATE TABLE workspace_database_routes (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  database_key text NOT NULL UNIQUE,
  binding_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('preparing','active'))
);
CREATE TABLE dedicated_database_identity (
  singleton boolean PRIMARY KEY CHECK (singleton),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  binding_id uuid NOT NULL,
  delivered_event bigint NOT NULL DEFAULT 0
);
CREATE TABLE workspace_identity_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  type text NOT NULL,
  event_key text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX workspace_identity_delivery ON workspace_identity_events(workspace_id,id);
