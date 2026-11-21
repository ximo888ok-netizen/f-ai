CREATE TABLE inventory_draft_imports (
  book_id uuid NOT NULL REFERENCES operation_books(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  preview_id text NOT NULL,
  draft_id uuid NOT NULL REFERENCES listing_drafts(id),
  counted_on date NOT NULL,
  threshold integer NOT NULL CHECK (threshold >= 0),
  inserted integer NOT NULL CHECK (inserted > 0),
  PRIMARY KEY (book_id, account_id, preview_id)
);
CREATE INDEX operation_inventory_sku ON operation_records (book_id, lower(btrim(reference))) WHERE kind = 'inventory';
