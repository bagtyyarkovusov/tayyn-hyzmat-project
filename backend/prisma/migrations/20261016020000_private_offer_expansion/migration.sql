-- Additive, backward-compatible policy for private-offer expiry.
-- Existing and new orders expand by default; set false only for an explicit
-- dispatcher stop decision.
ALTER TABLE "orders"
  ADD COLUMN "broadcast_after_private_expiry" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "orders"
  ADD COLUMN "private_offer_stopped_at" TIMESTAMP(3);

ALTER TABLE "orders"
  ADD COLUMN "public_region_only_until" TIMESTAMP(3),
  ADD COLUMN "public_released_globally_at" TIMESTAMP(3);
-- Already-public legacy orders keep their existing cross-region availability.
UPDATE "orders" SET "public_released_globally_at" = CURRENT_TIMESTAMP
WHERE "status" = 'NEW' AND "private_offer_driver_id" IS NULL;
