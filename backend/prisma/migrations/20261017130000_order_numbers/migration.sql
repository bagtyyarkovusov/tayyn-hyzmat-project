-- Stable human-facing order identity. UUID remains the internal/API key.
BEGIN;
LOCK TABLE "orders" IN ACCESS EXCLUSIVE MODE;
CREATE SEQUENCE "order_number_seq";

ALTER TABLE "orders" ADD COLUMN "order_number" INTEGER;

WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "created_at" ASC, "id" ASC)::integer AS "number"
  FROM "orders"
)
UPDATE "orders" AS orders
SET "order_number" = numbered."number"
FROM numbered
WHERE orders."id" = numbered."id";

-- Existing wallet notes are human-facing too; rewrite only the known order
-- reference prefix while retaining the internal order_id relation.
UPDATE "transactions" AS transactions
SET "note" = regexp_replace(transactions."note", 'Заказ #[0-9a-fA-F-]{36}', 'Заказ #' || orders."order_number")
FROM "orders" AS orders
WHERE transactions."order_id" = orders."id"
  AND transactions."note" LIKE 'Заказ #%';

SELECT setval('"order_number_seq"', COALESCE((SELECT MAX("order_number") FROM "orders"), 1), (SELECT COUNT(*) > 0 FROM "orders"));
ALTER SEQUENCE "order_number_seq" OWNED BY "orders"."order_number";
ALTER TABLE "orders" ALTER COLUMN "order_number" SET DEFAULT nextval('"order_number_seq"');
ALTER TABLE "orders" ALTER COLUMN "order_number" SET NOT NULL;
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");
COMMIT;
