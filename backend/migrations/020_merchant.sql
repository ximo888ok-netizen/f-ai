ALTER TABLE memberships ADD COLUMN state text NOT NULL DEFAULT 'active'
  CHECK (state IN ('active', 'suspended'));

ALTER TABLE invitations ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE invitations ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE invitations ADD COLUMN revoked_at timestamptz;
ALTER TABLE invitations ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE invitations ADD CONSTRAINT invitations_id_unique UNIQUE (id);
WITH duplicates AS (
  SELECT id, row_number() OVER (PARTITION BY workspace_id,email ORDER BY expires_at DESC,id DESC) AS rank
  FROM invitations WHERE accepted_at IS NULL
)
UPDATE invitations SET revoked_at=now() FROM duplicates
WHERE invitations.id=duplicates.id AND duplicates.rank>1;
CREATE UNIQUE INDEX invitations_pending_email ON invitations(workspace_id,email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE plugin_settings ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE plugin_settings ADD COLUMN release_mode text NOT NULL DEFAULT 'all'
  CHECK (release_mode IN ('all','trial'));
ALTER TABLE plugin_settings ADD COLUMN release_version text;
ALTER TABLE plugin_settings ADD COLUMN release_capabilities jsonb
  CHECK (release_capabilities IS NULL OR jsonb_typeof(release_capabilities)='array');
ALTER TABLE tasks ADD COLUMN feature_version text;

CREATE TABLE merchant_plugin_members (
  workspace_id uuid NOT NULL,
  plugin_id text NOT NULL,
  account_id uuid NOT NULL,
  PRIMARY KEY (workspace_id,plugin_id,account_id),
  FOREIGN KEY (workspace_id,plugin_id) REFERENCES plugin_settings(workspace_id,plugin_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,account_id) REFERENCES memberships(workspace_id,account_id)
);

CREATE TABLE merchant_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('identity','workspace')),
  action text NOT NULL,
  target_id text NOT NULL,
  detail jsonb NOT NULL,
  request_id text NOT NULL,
  occurred_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX merchant_events_lookup ON merchant_events(workspace_id,scope,occurred_at DESC,id DESC);

CREATE TABLE merchant_connections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL CHECK (kind IN ('model','shop','feishu','webdav')),
  connector_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 0 CHECK (revision>=0),
  check_state text NOT NULL DEFAULT 'unverified' CHECK (check_state IN ('unverified','reachable','failed')),
  checked_at timestamptz,
  PRIMARY KEY(workspace_id,kind,connector_id)
);
