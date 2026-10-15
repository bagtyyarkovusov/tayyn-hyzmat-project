-- AlterEnum
BEGIN;
CREATE TYPE "OrderStatus_new" AS ENUM ('NEW', 'ACCEPTED', 'WAITING', 'STARTED', 'COMPLETED', 'CANCELLED');
ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "status" TYPE "OrderStatus_new" USING ("status"::text::"OrderStatus_new");
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "OrderStatus_old";
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'NEW';
COMMIT;

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'PAYMENT';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "client_phone" TEXT,
ADD COLUMN     "distance_fee" DECIMAL(10,2),
ADD COLUMN     "eta_minutes" INTEGER,
ADD COLUMN     "wait_fee" DECIMAL(10,2),
ALTER COLUMN "status" SET DEFAULT 'NEW';

