-- Older credentials did not record their issuer. Bind them to the known agent creator.
-- Orphaned agents remain unbound and fail authentication.
UPDATE "api_keys" AS k SET "user_id" = a."created_by"
FROM "agents" AS a WHERE k."agent_id" = a."id" AND k."user_id" IS NULL;
