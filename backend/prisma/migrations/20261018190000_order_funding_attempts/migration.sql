-- Additive only. Existing assigned orders remain legacy-funded and are
-- resolved against their existing ledger; no hold or payment is invented.
ALTER TABLE "orders" ADD COLUMN "offer_attempt_id" TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "orders" ADD COLUMN "offer_attempt_kind" TEXT NOT NULL DEFAULT 'order';
ALTER TABLE "orders" ADD COLUMN "cancellation_review_required" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "order_assignments" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "driver_id" TEXT NOT NULL,
  "offer_attempt_id" TEXT NOT NULL,
  "quoted_amount" DECIMAL(10,2) NOT NULL,
  "funding_state" TEXT NOT NULL,
  "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "captured_at" TIMESTAMP(3),
  "released_at" TIMESTAMP(3),
  "ended_at" TIMESTAMP(3),
  "end_action" TEXT,
  CONSTRAINT "order_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_assignments_quote_check" CHECK ("quoted_amount" >= 0),
  CONSTRAINT "order_assignments_funding_check" CHECK ("funding_state" IN ('HELD', 'CAPTURED', 'RELEASED', 'UNPRICED')),
  CONSTRAINT "order_assignments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "order_assignments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "order_assignments_order_id_offer_attempt_id_key" ON "order_assignments"("order_id", "offer_attempt_id");
CREATE INDEX "order_assignments_driver_id_funding_state_idx" ON "order_assignments"("driver_id", "funding_state");
CREATE INDEX "orders_status_cancellation_review_required_cancelled_at_id_idx" ON "orders"("status", "cancellation_review_required", "cancelled_at", "id");

-- Preserve the original admin adjustment response across retries even if a
-- later assignment changes held funds. Old ledger rows remain untouched.
ALTER TABLE "transactions" ADD COLUMN "held_after" DECIMAL(12,2);

ALTER TABLE "order_resolution_audits" ADD COLUMN "offer_attempt_id" TEXT;
ALTER TABLE "order_resolution_audits" ADD COLUMN "next_offer_attempt_id" TEXT;
ALTER TABLE "order_resolution_audits" ADD COLUMN "driver_id" TEXT;
