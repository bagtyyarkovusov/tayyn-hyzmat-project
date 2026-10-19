CREATE TABLE "driver_activity_audits" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "driver_id" TEXT NOT NULL,
  "actor_id" TEXT,
  "actor_name" TEXT,
  "driver_name" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "driver_activity_audits_created_at_id_idx" ON "driver_activity_audits"("created_at", "id");
CREATE INDEX "driver_activity_audits_driver_id_created_at_idx" ON "driver_activity_audits"("driver_id", "created_at");

-- Only the last retained state timestamps are known before this migration.
-- Preserve those facts without inventing earlier approval/block transitions.
INSERT INTO "driver_activity_audits" ("id", "driver_id", "actor_id", "actor_name", "driver_name", "action", "created_at")
SELECT 'legacy-approval-' || d.id, d.id, d.approved_by, a.full_name, u.full_name, 'APPROVED', d.approved_at
FROM drivers d JOIN users u ON u.id = d.user_id LEFT JOIN users a ON a.id = d.approved_by
WHERE d.approved_at IS NOT NULL;
INSERT INTO "driver_activity_audits" ("id", "driver_id", "actor_id", "actor_name", "driver_name", "action", "reason", "created_at")
SELECT 'legacy-block-' || d.id, d.id, d.blocked_by, a.full_name, u.full_name, 'BLOCKED', d.block_reason, d.blocked_at
FROM drivers d JOIN users u ON u.id = d.user_id LEFT JOIN users a ON a.id = d.blocked_by
WHERE d.blocked_at IS NOT NULL;
