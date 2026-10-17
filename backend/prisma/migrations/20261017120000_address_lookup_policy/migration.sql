-- Additive expansion only. An application rollback keeps these nullable/defaulted
-- columns; remove them only in a later forward migration after all readers stop.
ALTER TABLE "driver_devices" ADD COLUMN "address_convenience_at" TIMESTAMPTZ;
ALTER TABLE "driver_address_state" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'shift', ADD COLUMN "online_exception_ready" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "pending_until" TIMESTAMPTZ;
