ALTER TABLE "native_shift_leases" ADD COLUMN "credential_version" INTEGER NOT NULL DEFAULT 0;
-- Existing opaque credentials predate version binding; require a new visible Online action.
UPDATE "native_shift_leases" SET "revoked_at" = NOW() WHERE "revoked_at" IS NULL;
