CREATE TABLE image_platform_templates (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  platform text NOT NULL CHECK (platform IN ('taobao','pinduoduo','douyin')),
  revision integer NOT NULL CHECK (revision > 0),
  width integer NOT NULL CHECK (width BETWEEN 32 AND 1920),
  height integer NOT NULL CHECK (height BETWEEN 32 AND 6144),
  fit text NOT NULL CHECK (fit IN ('cover','contain')),
  format text NOT NULL CHECK (format IN ('png','jpeg')),
  CHECK (width * height <= 4000000),
  PRIMARY KEY (workspace_id,platform,revision)
);
