CREATE TABLE agency_partners (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  tier integer NOT NULL CHECK (tier IN (1,2)),
  parent_id uuid,
  parent_tier integer NOT NULL DEFAULT 1 CHECK (parent_tier=1),
  CHECK ((tier=1 AND parent_id IS NULL) OR (tier=2 AND parent_id IS NOT NULL AND parent_id<>account_id)),
  PRIMARY KEY (workspace_id,account_id),
  UNIQUE (workspace_id,account_id,tier),
  FOREIGN KEY (workspace_id,account_id) REFERENCES memberships(workspace_id,account_id),
  FOREIGN KEY (workspace_id,parent_id,parent_tier) REFERENCES agency_partners(workspace_id,account_id,tier) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE agency_rates (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  direct_bps integer NOT NULL CHECK (direct_bps BETWEEN 0 AND 10000),
  management_bps integer NOT NULL CHECK (management_bps BETWEEN 0 AND 10000),
  CHECK (direct_bps+management_bps<=10000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0)
);
CREATE TABLE agency_receipts (
  workspace_id uuid NOT NULL,
  reference text NOT NULL,
  agent_id uuid NOT NULL,
  parent_id uuid,
  booked_on date NOT NULL,
  paid_minor integer NOT NULL CHECK (paid_minor>0),
  reversed_minor integer NOT NULL DEFAULT 0 CHECK (reversed_minor BETWEEN 0 AND paid_minor),
  rate_revision integer NOT NULL,
  direct_bps integer NOT NULL CHECK (direct_bps BETWEEN 0 AND 10000),
  management_bps integer NOT NULL CHECK (management_bps BETWEEN 0 AND 10000),
  recorded_by uuid NOT NULL,
  PRIMARY KEY (workspace_id,reference),
  FOREIGN KEY (workspace_id,agent_id) REFERENCES agency_partners(workspace_id,account_id),
  FOREIGN KEY (workspace_id,parent_id) REFERENCES agency_partners(workspace_id,account_id),
  FOREIGN KEY (workspace_id,recorded_by) REFERENCES memberships(workspace_id,account_id)
);
CREATE INDEX agency_receipts_month ON agency_receipts(workspace_id,booked_on);
CREATE TABLE agency_reversals (
  workspace_id uuid NOT NULL,
  reference text NOT NULL,
  receipt_reference text NOT NULL,
  booked_on date NOT NULL,
  reason text NOT NULL CHECK (reason IN ('refund','return','chargeback')),
  amount_minor integer NOT NULL CHECK (amount_minor>0),
  before_minor integer NOT NULL CHECK (before_minor>=amount_minor),
  recorded_by uuid NOT NULL,
  PRIMARY KEY (workspace_id,reference),
  FOREIGN KEY (workspace_id,receipt_reference) REFERENCES agency_receipts(workspace_id,reference),
  FOREIGN KEY (workspace_id,recorded_by) REFERENCES memberships(workspace_id,account_id)
);
CREATE INDEX agency_reversals_receipt ON agency_reversals(workspace_id,receipt_reference,booked_on DESC);
CREATE INDEX agency_reversals_month ON agency_reversals(workspace_id,booked_on);
