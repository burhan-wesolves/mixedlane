ALTER TABLE "orgs" ADD COLUMN "agent_skill" text;
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "agent_skill_version" integer DEFAULT 0 NOT NULL;
