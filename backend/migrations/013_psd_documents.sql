CREATE TABLE studio_psd_documents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  title text NOT NULL,
  layout jsonb NOT NULL,
  subject_asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  background_asset_id uuid REFERENCES assets(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,account_id) REFERENCES memberships(workspace_id,account_id)
);
CREATE INDEX studio_psd_owner ON studio_psd_documents (workspace_id,account_id,updated_at DESC,id);
CREATE INDEX studio_psd_subject ON studio_psd_documents (subject_asset_id);
CREATE INDEX studio_psd_background ON studio_psd_documents (background_asset_id) WHERE background_asset_id IS NOT NULL;
