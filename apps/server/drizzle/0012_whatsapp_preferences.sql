ALTER TABLE whatsapp_connections ADD COLUMN default_project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE whatsapp_connections ADD COLUMN ask_project_every_time boolean NOT NULL DEFAULT true;
