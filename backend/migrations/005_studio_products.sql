
CREATE TABLE studio_categories (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  UNIQUE (workspace_id, name),
  UNIQUE (workspace_id, id)
);

CREATE TABLE studio_products (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  category_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, category_id) REFERENCES studio_categories(workspace_id, id),
  UNIQUE (workspace_id, sku)
);

CREATE TABLE studio_transfers (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('import','export')),
  count integer NOT NULL,
  reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, account_id, direction, reference)
);
