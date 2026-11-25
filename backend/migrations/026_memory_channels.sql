ALTER TABLE memory_items ADD COLUMN revision integer NOT NULL DEFAULT 0;

CREATE TABLE memory_changes (
  item_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL CHECK (action IN ('update','undo')),
  previous_content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, revision),
  UNIQUE (item_id, request_id)
);

CREATE TABLE wechat_messages (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel text NOT NULL CHECK (channel IN ('wechat','wecom')),
  connector text NOT NULL,
  receiver text NOT NULL,
  message_id text NOT NULL,
  sender text NOT NULL,
  content text NOT NULL,
  reply_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,channel,connector,receiver,message_id)
);

CREATE INDEX task_events_export ON task_events (created_at,id);
