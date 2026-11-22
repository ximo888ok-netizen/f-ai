ALTER TABLE documents ADD COLUMN customer_scope jsonb;
ALTER TABLE service_conversations ADD COLUMN product_id uuid;
UPDATE service_conversations c SET product_id=p.id FROM studio_products p
  WHERE c.workspace_id=p.workspace_id AND c.product_reference=p.sku AND p.updated_at<=c.created_at;
CREATE INDEX documents_customer_product ON documents (workspace_id, base_id, (customer_scope->>'productId')) WHERE customer_scope IS NOT NULL;
ALTER TABLE assets ADD COLUMN image_source_review jsonb;
