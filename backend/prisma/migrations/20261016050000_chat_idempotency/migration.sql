ALTER TABLE "messages" ADD COLUMN "client_message_id" TEXT;
CREATE UNIQUE INDEX CONCURRENTLY "messages_sender_id_client_message_id_key" ON "messages"("sender_id", "client_message_id");
