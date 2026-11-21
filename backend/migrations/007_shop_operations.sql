CREATE TABLE operation_books (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,name)
);
CREATE TABLE operation_records (
  book_id uuid NOT NULL REFERENCES operation_books(id),
  kind text NOT NULL,
  reference text NOT NULL,
  details jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id,kind,reference)
);
CREATE UNIQUE INDEX operation_daily_sku ON operation_records (book_id,(details->>'sku'),(details->>'day')) WHERE kind='performance';
CREATE INDEX operation_records_status ON operation_records (book_id,kind,(details->>'status'));
