CREATE TABLE listing_draft_variants (
  draft_id uuid NOT NULL REFERENCES listing_drafts(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  specification text NOT NULL,
  sku text NOT NULL,
  price_minor integer CHECK (price_minor >= 0),
  stock integer CHECK (stock >= 0),
  asset_id uuid REFERENCES assets(id) ON DELETE RESTRICT,
  PRIMARY KEY (draft_id, position),
  UNIQUE (draft_id, specification)
);
CREATE INDEX listing_draft_variants_asset ON listing_draft_variants (asset_id) WHERE asset_id IS NOT NULL;
