ALTER TABLE agents ADD COLUMN item_scope text NOT NULL DEFAULT 'own';
--> statement-breakpoint
ALTER TABLE agents ADD COLUMN page_scope text NOT NULL DEFAULT 'own';
--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN created_by_agent_id uuid;
--> statement-breakpoint
ALTER TABLE pages ADD COLUMN created_by_agent_id uuid;
--> statement-breakpoint
-- Work-item creation has an immutable, typed audit record. Historical page
-- versions only store a display name for agents, so cannot establish identity.
UPDATE work_items w SET created_by_agent_id = a.actor_id
FROM activity a
WHERE a.work_item_id = w.id AND a.org_id = w.org_id
  AND a.action = 'created' AND a.actor_type = 'agent';
--> statement-breakpoint
CREATE INDEX work_items_agent_creator_idx ON work_items (created_by_agent_id, project_id);
--> statement-breakpoint
CREATE INDEX pages_agent_creator_idx ON pages (created_by_agent_id, space_id);
