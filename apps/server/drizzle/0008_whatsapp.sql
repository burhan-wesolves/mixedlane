CREATE TABLE whatsapp_connections (
 org_id uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
 base_url text NOT NULL, api_key_enc text NOT NULL, callback_url text NOT NULL,
 providers_enc text NOT NULL, webhook_secret text NOT NULL
);
--> statement-breakpoint
CREATE TABLE whatsapp_sessions (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 name text NOT NULL, webhook_id text, managed boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE TABLE whatsapp_contacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 phone text NOT NULL, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX whatsapp_contact_phone_idx ON whatsapp_contacts(org_id, phone);
--> statement-breakpoint
CREATE TABLE whatsapp_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
 message_id text NOT NULL, chat_id text NOT NULL, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 project_id uuid REFERENCES projects(id) ON DELETE CASCADE, report text NOT NULL, proposal jsonb,
 provider text, preview_message_id text, status text NOT NULL DEFAULT 'select_project', item_id uuid REFERENCES work_items(id) ON DELETE SET NULL,
 error text, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX whatsapp_draft_message_idx ON whatsapp_drafts(session_id, message_id);
--> statement-breakpoint
CREATE TABLE whatsapp_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
 event_key text NOT NULL, payload jsonb NOT NULL, processed boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE UNIQUE INDEX whatsapp_event_key_idx ON whatsapp_events(session_id, event_key);
