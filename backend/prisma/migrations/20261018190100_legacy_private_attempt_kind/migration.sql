-- Classify only existing private offers. No balances, ledger rows, assignments
-- or order statuses change. Fresh public attempts already use the default.
UPDATE "orders" SET "offer_attempt_kind" = 'private'
WHERE "private_offer_expires_at" IS NOT NULL AND "offer_attempt_kind" = 'order';
