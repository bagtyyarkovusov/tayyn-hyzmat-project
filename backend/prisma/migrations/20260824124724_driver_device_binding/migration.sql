-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "current_device_id" TEXT,
ADD COLUMN     "pending_device_id" TEXT,
ADD COLUMN     "pending_device_requested_at" TIMESTAMP(3);
