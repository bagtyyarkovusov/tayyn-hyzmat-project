-- Read-only diagnostic before the 1.21 migration. Quiesce writers first.
-- The migration repeats these checks under locks before any DDL/ledger write.
BEGIN READ ONLY;
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

ROLLBACK;
