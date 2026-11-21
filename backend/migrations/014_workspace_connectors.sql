CREATE TABLE asset_cloud_copies (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  binding_hash text NOT NULL,
  name text NOT NULL,
  media_type text NOT NULL,
  source text NOT NULL,
  purpose text NOT NULL,
  consent_reference text,
  consent_expires_at timestamptz,
  sha256 text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  state text NOT NULL CHECK (state IN ('pending','ready')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,account_id,asset_id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES memberships(workspace_id,account_id)
);
CREATE INDEX asset_cloud_copies_owner ON asset_cloud_copies(workspace_id,account_id,created_at DESC,asset_id);
CREATE TABLE feishu_messages (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connector_id text NOT NULL,
  event_id text NOT NULL,
  binding_hash text NOT NULL,
  chat_id text NOT NULL,
  remote_message_id text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,connector_id,event_id),
  UNIQUE(workspace_id,connector_id,remote_message_id)
);
CREATE INDEX feishu_messages_workspace ON feishu_messages(workspace_id,created_at DESC,event_id);
CREATE TABLE feishu_replies (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  connector_id text NOT NULL,
  event_id text NOT NULL,
  content text NOT NULL,
  state text NOT NULL CHECK(state IN ('queued','sending','sent','failed','uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  first_attempt_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  remote_message_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES memberships(workspace_id,account_id),
  FOREIGN KEY(workspace_id,connector_id,event_id) REFERENCES feishu_messages(workspace_id,connector_id,event_id)
);
CREATE INDEX feishu_pending_replies ON feishu_replies(available_at,id) WHERE state IN ('queued','sending');
CREATE INDEX feishu_replies_parent ON feishu_replies(workspace_id,connector_id,event_id,created_at DESC);
