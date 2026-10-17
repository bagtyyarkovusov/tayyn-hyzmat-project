-- Additive identity archive. Deletion releases the login phone in its own
-- application transaction; historical records and relations are retained.
-- Forward-only: keep these nullable columns if reverting application code.
ALTER TABLE "users"
  ADD COLUMN "archived_phone" TEXT,
  ADD COLUMN "deleted_at" TIMESTAMP(3);
