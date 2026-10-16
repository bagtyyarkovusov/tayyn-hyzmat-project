CREATE TABLE "order_resolution_audits" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_resolution_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_resolution_audits_order_id_created_at_idx" ON "order_resolution_audits"("order_id", "created_at");
ALTER TABLE "order_resolution_audits" ADD CONSTRAINT "order_resolution_audits_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_resolution_audits" ADD CONSTRAINT "order_resolution_audits_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
