-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "current_device_label" TEXT,
ADD COLUMN     "pending_device_label" TEXT;

-- CreateTable
CREATE TABLE "driver_devices" (
    "id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "label" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_devices_driver_id_device_id_key" ON "driver_devices"("driver_id", "device_id");

-- AddForeignKey
ALTER TABLE "driver_devices" ADD CONSTRAINT "driver_devices_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
