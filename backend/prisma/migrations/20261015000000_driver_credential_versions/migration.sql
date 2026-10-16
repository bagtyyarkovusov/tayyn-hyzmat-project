ALTER TABLE "users" ADD COLUMN "credential_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "refresh_tokens" ADD COLUMN "credential_version" INTEGER NOT NULL DEFAULT 0;
