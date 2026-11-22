CREATE TABLE image_series_presets (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  name text NOT NULL,
  configuration jsonb NOT NULL,
  PRIMARY KEY (workspace_id,account_id,id,revision)
);
