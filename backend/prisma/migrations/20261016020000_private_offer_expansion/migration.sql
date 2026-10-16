-- Additive, backward-compatible policy for private-offer expiry.
-- Existing and new orders expand by default; set false only for an explicit
-- dispatcher stop decision.
ALTER TABLE "orders"
  ADD COLUMN "broadcast_after_private_expiry" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "orders"
  ADD COLUMN "private_offer_stopped_at" TIMESTAMP(3);
