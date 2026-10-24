ALTER TABLE uploads ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE uploads ADD COLUMN space_id uuid REFERENCES spaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE uploads ADD COLUMN upload_state text NOT NULL DEFAULT 'ready';
