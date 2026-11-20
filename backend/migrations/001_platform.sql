
CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('enterprise', 'personal', 'agent')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('enterprise', 'personal', 'agent')),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id)
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  expires_at timestamptz NOT NULL
);

CREATE TABLE invitations (
  token_hash text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);

CREATE TABLE wallets (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= balance),
  PRIMARY KEY (workspace_id, account_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES memberships(workspace_id, account_id)
);

CREATE TABLE ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  reference text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('credit', 'transfer_in', 'transfer_out', 'reserve', 'settle', 'release')),
  amount integer NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES wallets(workspace_id, account_id),
  UNIQUE (workspace_id, account_id, reference, operation)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE project_members (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  account_id uuid NOT NULL,
  PRIMARY KEY (project_id, account_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES memberships(workspace_id, account_id) ON DELETE CASCADE
);

CREATE TABLE knowledge_bases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE knowledge_grants (
  workspace_id uuid NOT NULL,
  base_id uuid NOT NULL,
  account_id uuid NOT NULL,
  PRIMARY KEY (base_id, account_id),
  FOREIGN KEY (workspace_id, base_id) REFERENCES knowledge_bases(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES memberships(workspace_id, account_id) ON DELETE CASCADE
);

CREATE TABLE documents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  base_id uuid NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT '',
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, base_id) REFERENCES knowledge_bases(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE document_chunks (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  content text NOT NULL,
  PRIMARY KEY (document_id, ordinal)
);

CREATE TABLE assets (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  name text NOT NULL,
  media_type text NOT NULL,
  source text NOT NULL,
  purpose text NOT NULL,
  consent_reference text,
  consent_expires_at timestamptz,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES memberships(workspace_id, account_id)
);

CREATE TABLE plugin_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  plugin_id text NOT NULL,
  enabled boolean NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  project_id uuid,
  parent_id uuid REFERENCES tasks(id),
  capability_id text NOT NULL,
  provider_id text NOT NULL,
  plugin_id text NOT NULL,
  input jsonb NOT NULL,
  request_hash text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  cost integer NOT NULL CHECK (cost > 0),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_id uuid,
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES wallets(workspace_id, account_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  UNIQUE (workspace_id, account_id, idempotency_key)
);

CREATE INDEX tasks_worker ON tasks (state, available_at, lease_until);
CREATE INDEX tasks_owner ON tasks (workspace_id, account_id, created_at DESC);
CREATE INDEX documents_base ON documents (workspace_id, base_id);

CREATE TABLE notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  type text NOT NULL,
  event_key text NOT NULL,
  data jsonb NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES memberships(workspace_id, account_id),
  UNIQUE (workspace_id, account_id, event_key)
);

CREATE INDEX notifications_account ON notifications (workspace_id, account_id, id DESC);

CREATE TABLE account_settings (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  preferences jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (workspace_id, account_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES memberships(workspace_id, account_id)
);

CREATE TABLE memory_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('personal', 'enterprise')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES memberships(workspace_id, account_id)
);

CREATE TABLE shop_previews (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  capability_id text NOT NULL,
  parameters jsonb NOT NULL,
  shop_fingerprint text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  FOREIGN KEY (workspace_id, account_id) REFERENCES memberships(workspace_id, account_id)
);
