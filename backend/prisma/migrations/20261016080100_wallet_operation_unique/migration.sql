CREATE UNIQUE INDEX CONCURRENTLY "transactions_created_by_operation_id_key"
ON "transactions"("created_by", "operation_id");
