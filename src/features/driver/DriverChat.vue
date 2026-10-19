<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";

import { Button } from "@/shared/ui/button";
import ChatComposer from "@/shared/ChatComposer.vue";
import { useChatRecovery } from "@/shared/useChatRecovery";
import { useChatScroll } from "@/shared/useChatScroll";
import { driverApi, errorMessage } from "@/shared/api";
import { driverSession } from "@/features/auth/session";
import { chatDraft, useDriver } from "./useDriver";
import { closeChatAlerts } from "./alerts";
import { date, type Message, type Page } from "./model";
const { state } = useDriver();
const { history, track, updated, followAfterSend } = useChatScroll();
const messages = ref<Message[]>([]),
  draft = chatDraft,
  error = ref(""),
  loading = ref(false),
  sending = ref(false),
  page = ref(1),
  total = ref(0);
const loadFailed = ref(false);
let alive = true;
let refreshQueued = false;
let retryMessage: { body: string; id: string } | undefined;
async function load(older = false) {
  if (loading.value) {
    if (!older) refreshQueued = true;
    return;
  }
  loading.value = true;
  loadFailed.value = false;
  error.value = "";
  try {
    const previousHeight = history.value?.scrollHeight ?? 0;
    const next = older ? page.value + 1 : 1;
    const anchor = older ? undefined : messages.value.at(-1)?.id;
    let fetchedPage = next;
    const { data } = await driverApi.get<Page<Message>>("/driver/messages", {
      params: {
        page: older ? 1 : fetchedPage,
        limit: 50,
        ...(older && messages.value[0]
          ? { beforeMessageId: messages.value[0].id }
          : {}),
      },
    });
    let oldestFetched = data.items[0]?.id;
    // Reconnect can miss more than one page. Fetch back to the last known
    // message before merging, rather than leaving a silent gap in the thread.
    while (
      anchor &&
      !data.items.some((message) => message.id === anchor) &&
      fetchedPage * 50 < data.total
    ) {
      const more = await driverApi.get<Page<Message>>("/driver/messages", {
        params: { beforeMessageId: oldestFetched, limit: 50 },
      });
      fetchedPage++;
      if (!alive) return;
      oldestFetched = more.data.items[0]?.id;
      if (!oldestFetched) break;
      data.items.push(...more.data.items);
    }
    if (!alive) return;
    if (older) page.value = next;
    total.value = data.total;
    const combined = [...messages.value, ...data.items];
    messages.value = [...new Map(combined.map((m) => [m.id, m])).values()].sort(
      (a, b) =>
        Date.parse(a.sentAt) - Date.parse(b.sentAt) || a.id.localeCompare(b.id),
    );
    if (!document.hidden) {
      const lastIncoming = [...messages.value]
        .reverse()
        .find((message) => message.senderId !== state.profile?.userId);
      if (lastIncoming)
        await driverApi.post("/driver/messages/read", {
          throughMessageId: lastIncoming.id,
        });
      closeChatAlerts();
    }
    if (older) {
      await nextTick();
      if (history.value)
        history.value.scrollTop += history.value.scrollHeight - previousHeight;
    } else await updated();
  } catch (e) {
    if (alive) {
      error.value = errorMessage(e);
      loadFailed.value = true;
    }
  } finally {
    loading.value = false;
    if (refreshQueued && alive) {
      refreshQueued = false;
      void load();
    }
  }
}
async function send() {
  const body = draft.value.trim();
  if (!body || sending.value) return;
  const finishScroll = followAfterSend();
  if (retryMessage?.body !== body)
    retryMessage = { body, id: crypto.randomUUID() };
  sending.value = true;
  error.value = "";
  try {
    const { data } = await driverApi.post<Message>("/driver/messages", {
      body,
      clientMessageId: retryMessage.id,
    });
    if (!alive) return;
    if (!messages.value.some((m) => m.id === data.id))
      messages.value.push(data);
    draft.value = "";
    retryMessage = undefined;
    await finishScroll();
  } catch (e) {
    if (alive) error.value = errorMessage(e);
  } finally {
    sending.value = false;
  }
}
const off = [
  driverSession.on("admin:message", () => void load()),
  driverSession.on("connect", () => void load()),
];
const onNotification = () => void load();
window.addEventListener("driver:notification-chat", onNotification);
useChatRecovery(() => void load());
onMounted(() => void load());
onUnmounted(() => {
  alive = false;
  window.removeEventListener("driver:notification-chat", onNotification);
  off.forEach((fn) => fn());
});
</script>
<template>
  <div class="mx-auto flex h-full min-h-0 max-w-3xl flex-col gap-2">
    <header class="flex shrink-0 items-center justify-between">
      <div>
        <h1 class="text-lg font-semibold">Диспетчер</h1>
      </div>
    </header>
    <p
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
    >
      {{ error }}
      <Button
        v-if="loadFailed"
        variant="outline"
        :disabled="loading"
        @click="load()"
        >Повторить</Button
      >
    </p>
    <section
      ref="history"
      class="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain rounded-xl border bg-card p-3"
      @scroll="track"
      aria-label="Переписка"
      aria-live="polite"
    >
      <Button
        v-if="messages.length < total"
        variant="outline"
        class="mx-auto flex"
        :disabled="loading"
        @click="load(true)"
        >Предыдущие сообщения</Button
      >
      <p
        v-if="loading && !messages.length"
        class="muted py-10 text-center"
        role="status"
      >
        Загружаем сообщения…
      </p>
      <p v-else-if="!messages.length" class="muted py-10 text-center">
        Пока нет сообщений. Напишите диспетчеру, если нужна помощь.
      </p>
      <article
        v-for="m in messages"
        :key="m.id"
        class="flex"
        :class="
          m.senderId === state.profile?.userId ? 'justify-end' : 'justify-start'
        "
      >
        <div
          class="max-w-[88%] rounded-2xl px-4 py-3"
          :class="
            m.senderId === state.profile?.userId
              ? 'rounded-br-sm bg-primary text-primary-foreground'
              : 'rounded-bl-sm bg-muted text-foreground'
          "
        >
          <p class="whitespace-pre-wrap break-words text-sm">{{ m.body }}</p>
          <time class="mt-2 block text-xs opacity-80">{{
            date(m.sentAt)
          }}</time>
        </div>
      </article>
    </section>
    <ChatComposer
      v-model="draft"
      label="Сообщение диспетчеру"
      :pending="sending"
      @send="send"
    />
  </div>
</template>
