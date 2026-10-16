-- Short-lived native service credentials are separate from account JWTs.
-- Accessed with parameterized SQL so their opaque secret never enters profiles.
CREATE TABLE "native_shift_leases" (
  "driver_id" TEXT PRIMARY KEY REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "token_hash" TEXT NOT NULL UNIQUE,
  "device_id" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "revoked_at" TIMESTAMPTZ
);
