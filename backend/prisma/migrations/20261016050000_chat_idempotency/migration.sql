ALTER TABLE "messages" ADD COLUMN "client_message_id" TEXT;
CREATE UNIQUE INDEX "messages_sender_id_client_message_id_key" ON "messages"("sender_id", "client_message_id") WHERE "client_message_id" IS NOT NULL;

ALTER TABLE "drivers"
  ADD COLUMN "last_chat_read_message_id" TEXT,
  ADD COLUMN "last_read_by_admin_message_id" TEXT;
