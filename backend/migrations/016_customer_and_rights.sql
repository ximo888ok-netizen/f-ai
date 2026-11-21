ALTER TABLE service_conversations ADD COLUMN product_reference text;
ALTER TABLE service_conversations ADD COLUMN order_reference text;
ALTER TABLE service_messages ADD COLUMN client_id uuid;
ALTER TABLE service_messages ADD COLUMN request_hash text;
ALTER TABLE service_messages ADD COLUMN reply_to bigint;
CREATE UNIQUE INDEX service_message_client ON service_messages (conversation_id,client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX service_message_reply ON service_messages (conversation_id,reply_to) WHERE reply_to IS NOT NULL;

ALTER TABLE assets ADD COLUMN rights_restricted boolean NOT NULL DEFAULT false;
ALTER TABLE assets ADD COLUMN derived_ai boolean NOT NULL DEFAULT false;
ALTER TABLE asset_cloud_copies ADD COLUMN derived_ai boolean NOT NULL DEFAULT false;
ALTER TABLE workspace_library_entries ADD COLUMN skill_action text CHECK (skill_action IS NULL OR (skill_action IN ('copy-review','sku-review','model-chat') AND kind='skill'));

CREATE TABLE rights_notices (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  reporter_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  affected_id uuid NOT NULL,
  statement text NOT NULL,
  evidence_reference text NOT NULL,
  state text NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted','forwarded','restricted','counter_received','counter_forwarded','upheld','restored','dismissed')),
  revision integer NOT NULL DEFAULT 1,
  forwarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,reporter_id) REFERENCES memberships(workspace_id,account_id),
  FOREIGN KEY (workspace_id,affected_id) REFERENCES memberships(workspace_id,account_id)
);
CREATE INDEX rights_notices_asset ON rights_notices (workspace_id,asset_id,state);
CREATE INDEX rights_notices_workspace ON rights_notices (workspace_id,updated_at DESC,id);

CREATE TABLE rights_notice_events (
  workspace_id uuid NOT NULL,
  notice_id uuid NOT NULL,
  event_id uuid NOT NULL,
  revision integer NOT NULL,
  action text NOT NULL CHECK (action IN ('forward','restrict','counter','forward-counter','uphold','restore','dismiss')),
  actor_id uuid NOT NULL,
  explanation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,notice_id,event_id),
  UNIQUE (workspace_id,notice_id,revision),
  FOREIGN KEY (workspace_id,notice_id) REFERENCES rights_notices(workspace_id,id),
  FOREIGN KEY (workspace_id,actor_id) REFERENCES memberships(workspace_id,account_id)
);
