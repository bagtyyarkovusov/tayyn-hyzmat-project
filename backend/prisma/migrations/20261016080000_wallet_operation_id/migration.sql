-- Additive, nullable for pre-existing order and ledger records. Roll back app
-- behavior separately; retain operation IDs so committed retries remain safe.
ALTER TABLE "transactions" ADD COLUMN "operation_id" TEXT;
