-- Additive only. Rollback: stop sender/remove credentials, retain outbox tables.
-- A future forward migration may drop these unused tables after client rollback.
CREATE TABLE notification_installations (
 id TEXT PRIMARY KEY, driver_id TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL, credential_version INTEGER NOT NULL, device_version INTEGER NOT NULL,
 token TEXT UNIQUE, secret_hash TEXT UNIQUE, enabled BOOLEAN NOT NULL DEFAULT true,
 coordinator_enabled BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL,
 UNIQUE(driver_id,device_id)
);
CREATE TABLE notification_deliveries (
 id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES notification_installations(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL, channel TEXT NOT NULL, resource_id TEXT NOT NULL,
 expires_at TIMESTAMP(3) NOT NULL, not_before TIMESTAMP(3) NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, claimed_until TIMESTAMP(3), socket_sent_at TIMESTAMP(3), sent_at TIMESTAMP(3),
 acknowledged_at TIMESTAMP(3), cancelled_at TIMESTAMP(3), invalidated_at TIMESTAMP(3), invalidation_sent_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(installation_id,event_id)
);
CREATE INDEX notification_deliveries_acknowledged_at_not_before_idx ON notification_deliveries(acknowledged_at,not_before);
CREATE INDEX notification_deliveries_invalidated_at_invalidation_sent_at_idx ON notification_deliveries(invalidated_at,invalidation_sent_at);
