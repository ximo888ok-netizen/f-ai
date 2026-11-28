CREATE INDEX assets_owner_visible_created ON assets (workspace_id, account_id, created_at DESC, id) WHERE NOT rights_restricted;
CREATE INDEX ledger_owner_id ON ledger (workspace_id, account_id, id DESC);
CREATE INDEX sessions_expiry ON sessions (expires_at);
ALTER TABLE dedicated_database_identity ADD COLUMN identity_synced boolean NOT NULL DEFAULT false;
