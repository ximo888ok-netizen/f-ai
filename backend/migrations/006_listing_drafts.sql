CREATE TABLE listing_drafts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  title text NOT NULL,
  category text NOT NULL,
  description text NOT NULL,
  specification text NOT NULL,
  sku text NOT NULL,
  price_minor integer CHECK (price_minor >= 0),
  stock integer CHECK (stock >= 0),
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES memberships(workspace_id, account_id)
);
CREATE INDEX listing_drafts_owner ON listing_drafts (workspace_id, account_id, updated_at DESC, id);
CREATE TABLE listing_draft_images (
  draft_id uuid NOT NULL REFERENCES listing_drafts(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  role text NOT NULL CHECK (role IN ('main','sku','detail')),
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  PRIMARY KEY (draft_id, position),
  UNIQUE (draft_id, role, asset_id)
);
CREATE INDEX listing_draft_images_asset ON listing_draft_images (asset_id);
