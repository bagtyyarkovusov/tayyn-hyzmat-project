-- Additive: legacy driver tokens without a signed device require fresh login.
-- Preserve the current owner of an already-running shift.
ALTER TABLE drivers ADD COLUMN shift_device_id TEXT;
ALTER TABLE driver_devices ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE refresh_tokens ADD COLUMN device_id TEXT, ADD COLUMN device_version INTEGER;
UPDATE drivers SET shift_device_id = current_device_id WHERE is_online = true;
