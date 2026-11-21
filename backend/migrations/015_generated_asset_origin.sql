CREATE INDEX tasks_generated_asset ON tasks (workspace_id,account_id,(result->>'assetId')) WHERE state='succeeded';
