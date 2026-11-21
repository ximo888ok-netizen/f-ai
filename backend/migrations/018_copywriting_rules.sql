CREATE TABLE workspace_copywriting_rules (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  platform text NOT NULL CHECK (platform IN ('taobao','pinduoduo','douyin')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  title_limit integer NOT NULL CHECK (title_limit BETWEEN 1 AND 300),
  selling_point_limit integer NOT NULL CHECK (selling_point_limit BETWEEN 1 AND 1000),
  forbidden_phrases text[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,platform)
);
