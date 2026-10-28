ALTER TABLE "org_members" ADD COLUMN "restricted_projects" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "project_ids" jsonb;
--> statement-breakpoint
CREATE TABLE "project_revocations" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("project_id", "user_id")
);
