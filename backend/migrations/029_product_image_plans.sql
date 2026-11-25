CREATE TABLE product_image_plans (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  source jsonb NOT NULL,
  layout jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  confirmed_at timestamptz,
  requested_model_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES memberships(workspace_id, account_id)
);

CREATE INDEX product_image_plans_browse ON product_image_plans (workspace_id, account_id, updated_at DESC, id);

CREATE TABLE product_image_attempts (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 7),
  attempt integer NOT NULL CHECK (attempt > 0),
  task_id uuid NOT NULL UNIQUE REFERENCES tasks(id),
  PRIMARY KEY (workspace_id, account_id, plan_id, position, attempt),
  FOREIGN KEY (workspace_id, account_id, plan_id) REFERENCES product_image_plans(workspace_id, account_id, id)
);
