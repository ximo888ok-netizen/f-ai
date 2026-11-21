CREATE TABLE task_text_chunks (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 4096),
  content text NOT NULL CHECK (char_length(content) > 0),
  PRIMARY KEY (task_id,sequence)
);
