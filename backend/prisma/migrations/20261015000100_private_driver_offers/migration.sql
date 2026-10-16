-- Additive migration. Rollback: deploy code that ignores these nullable fields;
-- a later migration can drop them after all reservations have expired.
ALTER TABLE "orders" ADD COLUMN "private_offer_driver_id" TEXT,
  ADD COLUMN "private_offer_expires_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD CONSTRAINT "orders_private_offer_driver_fkey"
  FOREIGN KEY ("private_offer_driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "orders_one_private_offer_per_driver"
  ON "orders"("private_offer_driver_id") WHERE "status" = 'NEW' AND "private_offer_driver_id" IS NOT NULL;
