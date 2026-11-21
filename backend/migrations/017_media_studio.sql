CREATE TABLE studio_image_batches (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,account_id,id),
  FOREIGN KEY (workspace_id,account_id) REFERENCES memberships(workspace_id,account_id)
);

CREATE TABLE studio_video_storyboards (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  title text NOT NULL,
  configuration jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,account_id,id),
  FOREIGN KEY (workspace_id,account_id) REFERENCES memberships(workspace_id,account_id)
);
CREATE INDEX studio_storyboards_browse ON studio_video_storyboards (workspace_id,account_id,updated_at DESC,id);
