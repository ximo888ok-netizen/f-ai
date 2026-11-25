CREATE TABLE desk_shops (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL,
  name text NOT NULL,
  platform text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 0,
  seller_id text,
  grant_cipher text,
  expires_at timestamptz,
  auth_state text,
  auth_account uuid,
  auth_deadline timestamptz,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,platform,seller_id)
);
ALTER TABLE service_conversations ADD COLUMN shop_alias text;
