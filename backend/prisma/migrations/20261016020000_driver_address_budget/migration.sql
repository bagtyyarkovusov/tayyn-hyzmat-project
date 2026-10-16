-- Additive metadata table. Roll back application first; leave this table in
-- place to retain limits across rollback/redeploy. No existing region writes.
CREATE TABLE "driver_address_state" (
  "driver_id" TEXT PRIMARY KEY REFERENCES "drivers"("id") ON DELETE CASCADE,
  "attempted_at" TIMESTAMPTZ NOT NULL,
  "source_lat" DECIMAL(10,7) NOT NULL,
  "source_lng" DECIMAL(10,7) NOT NULL,
  "address" TEXT,
  "cache_until" TIMESTAMPTZ
);
CREATE TABLE "geocoder_budget" (
  "provider" TEXT PRIMARY KEY,
  "period" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "blocked_until" TIMESTAMPTZ
);
