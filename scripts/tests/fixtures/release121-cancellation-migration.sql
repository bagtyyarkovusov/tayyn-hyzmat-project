-- Quiesce writers for deployment. PostgreSQL rolls back this whole migration,
-- including DDL and ledger entries, if any preflight or conversion fails.
-- Take the strongest lock up front, in the application's driver, order,
-- wallet order, so later DDL never upgrades a lock behind an old server
-- transaction. A lock wait over 15 seconds fails and rolls back the deploy.
BEGIN;
SET LOCAL lock_timeout = '15s';
LOCK TABLE "drivers", "orders", "balances", "order_assignments", "transactions" IN ACCESS EXCLUSIVE MODE;

-- Read-only preflight BEFORE all schema/data writes. A held assignment proves
-- an unpaid accepted quote only when its current order, wallet and ledger agree.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM order_assignments a
    LEFT JOIN orders o ON o.id = a.order_id
    LEFT JOIN drivers d ON d.id = a.driver_id
    LEFT JOIN balances b ON b.user_id = d.user_id
    WHERE a.funding_state = 'HELD' AND (
      o.driver_id IS DISTINCT FROM a.driver_id OR o.offer_attempt_id <> a.offer_attempt_id
      OR o.status NOT IN ('ACCEPTED', 'WAITING', 'STARTED') OR a.ended_at IS NOT NULL
      OR a.captured_at IS NOT NULL OR a.released_at IS NOT NULL OR a.quoted_amount <= 0
      OR b.id IS NULL OR b.currency <> 'TMT'
      OR EXISTS (SELECT 1 FROM transactions t WHERE t.order_id = a.order_id
        AND t.type IN ('PAYMENT', 'REFUND') AND t.status <> 'FAILED')
    )
  ) THEN
    RAISE EXCEPTION 'LEGACY_FUNDING_AMBIGUOUS: held assignment does not prove one unpaid live quote';
  END IF;
  IF EXISTS (
    SELECT 1 FROM order_assignments a JOIN drivers d ON d.id = a.driver_id
    JOIN balances b ON b.user_id = d.user_id WHERE a.funding_state = 'HELD'
    GROUP BY b.id, b.amount HAVING b.amount < SUM(a.quoted_amount)
  ) THEN
    RAISE EXCEPTION 'LEGACY_FUNDING_AMBIGUOUS: wallet cannot cover its persisted holds';
  END IF;
END $$;

ALTER TABLE "orders" ADD COLUMN "cancellation_outcome" TEXT;
ALTER TABLE "orders" ADD COLUMN "cancelled_by" TEXT;
ALTER TABLE "orders" ADD COLUMN "cancellation_refund_amount" DECIMAL(10,2);
ALTER TABLE "transactions" ADD COLUMN "assignment_id" TEXT;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "order_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "transactions_assignment_id_type_key" ON "transactions"("assignment_id", "type");
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancellation_outcome_check" CHECK ("cancellation_outcome" IS NULL OR "cancellation_outcome" IN ('WITH_REFUND', 'WITHOUT_REFUND', 'BEFORE_ACCEPTANCE', 'NO_DEBIT'));

-- The immutable quote, rather than current order metadata, is the source.
DO $$
DECLARE held RECORD;
DECLARE remaining NUMERIC(12,2);
BEGIN
  FOR held IN
    SELECT a.*, d.user_id, o.order_number FROM order_assignments a
    JOIN drivers d ON d.id = a.driver_id JOIN orders o ON o.id = a.order_id
    WHERE a.funding_state = 'HELD' ORDER BY a.driver_id, a.order_id, a.id
  LOOP
    PERFORM id FROM drivers WHERE id = held.driver_id FOR UPDATE;
    PERFORM id FROM orders WHERE id = held.order_id FOR UPDATE;
    PERFORM id FROM balances WHERE user_id = held.user_id FOR UPDATE;
    UPDATE balances SET amount = amount - held.quoted_amount, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = held.user_id RETURNING amount INTO remaining;
    INSERT INTO transactions (id, balance_id, order_id, assignment_id, type, amount, balance_after, currency, status, note, created_at)
      SELECT gen_random_uuid()::text, id, held.order_id, held.id, 'PAYMENT', -held.quoted_amount,
        remaining, 'TMT', 'COMPLETED', 'Заказ #' || held.order_number || ': списание ранее удержанной цены при переходе на 1.21', CURRENT_TIMESTAMP
      FROM balances WHERE user_id = held.user_id;
    UPDATE order_assignments SET funding_state = 'CAPTURED', captured_at = CURRENT_TIMESTAMP WHERE id = held.id;
  END LOOP;
END $$;

-- Old servers cannot create new holds during a rolling deployment.
ALTER TABLE "order_assignments" ADD CONSTRAINT "order_assignments_no_new_holds_check" CHECK ("funding_state" <> 'HELD');
-- Retire review work without replaying any cancellation or refund.
-- Historical financial outcomes stay NULL, exposed as UNKNOWN by the API.
UPDATE "orders" SET "cancellation_review_required" = false WHERE "cancellation_review_required";
COMMIT;
