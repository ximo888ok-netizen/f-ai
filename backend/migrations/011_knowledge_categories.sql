CREATE TABLE knowledge_categories (
  workspace_id uuid NOT NULL,
  base_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) > 0),
  PRIMARY KEY (base_id,id),
  UNIQUE (base_id,name),
  FOREIGN KEY (workspace_id,base_id) REFERENCES knowledge_bases(workspace_id,id) ON DELETE CASCADE
);
INSERT INTO knowledge_categories(workspace_id,base_id,id,name)
SELECT workspace_id,base_id,gen_random_uuid(),category FROM (
  SELECT DISTINCT workspace_id,base_id,category FROM documents WHERE category<>''
) existing;
CREATE INDEX documents_category ON documents (workspace_id,base_id,category);
