
CREATE TABLE service_conversations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  operator_id uuid,
  subject text NOT NULL,
  knowledge_base_ids uuid[] NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN ('assistant', 'human')),
  last_search text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES memberships(workspace_id, account_id),
  FOREIGN KEY (workspace_id, operator_id) REFERENCES memberships(workspace_id, account_id)
);

CREATE TABLE service_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  sender text NOT NULL CHECK (sender IN ('customer', 'assistant', 'operator')),
  content text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES service_conversations(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX service_messages_conversation ON service_messages (conversation_id, id);
CREATE INDEX service_conversations_workspace ON service_conversations (workspace_id, updated_at DESC);

CREATE TABLE service_replies (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  title text NOT NULL,
  scenario text NOT NULL,
  content text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX service_replies_workspace ON service_replies (workspace_id, scenario, updated_at DESC);
