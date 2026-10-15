<script setup lang="ts">
import IncomingOrder from "./components/IncomingOrder.vue";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { RefreshCw } from "lucide-vue-next";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";
import ChatComposer from "@/shared/ChatComposer.vue";
import { useChatScroll } from "@/shared/useChatScroll";
import { driverApi, errorMessage } from "@/shared/api";
import { driverSession } from "@/features/auth/session";
import { useDriver } from "./useDriver";
import { date, type Message, type Page } from "./model";
const { state, dismissIncoming } = useDriver();
const offerOpen = computed({
  get: () => !!state.incoming && !state.active,
  set: (value) => {
    if (!value) dismissIncoming();
  },
});
const { history, track, updated } = useChatScroll();
const messages = ref<Message[]>([]),
  draft = ref(""),
  error = ref(""),
  loading = ref(false),
  sending = ref(false),
  page = ref(1),
  total = ref(0);
let alive = true;
let refreshQueued = false;
async function load(older = false) {
  if (loading.value) {
    if (!older) refreshQueued = true;
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const previousHeight = history.value?.scrollHeight ?? 0;
    const next = older ? page.value + 1 : 1;
    const { data } = await driverApi.get<Page<Message>>("/driver/messages", {
      params: { page: next, limit: 50 },
    });
    if (!alive) return;
    if (older) page.value = next;
    total.value = data.total;
    const combined = [...messages.value, ...data.items];
    messages.value = [...new Map(combined.map((m) => [m.id, m])).values()].sort(
      (a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt),
    );
    await driverApi.post("/driver/messages/read");
    if (older) {
      await nextTick();
      if (history.value)
        history.value.scrollTop += history.value.scrollHeight - previousHeight;
    } else await updated();
  } catch (e) {
    if (alive) error.value = errorMessage(e);
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
  sending.value = true;
  error.value = "";
  try {
    const { data } = await driverApi.post<Message>("/driver/messages", {
      body,
    });
    if (!alive) return;
    if (!messages.value.some((m) => m.id === data.id))
      messages.value.push(data);
    draft.value = "";
    await updated(true);
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
onMounted(() => void load());
onUnmounted(() => {
  alive = false;
  off.forEach((fn) => fn());
});
</script>
<template>
  <div class="mx-auto flex h-full min-h-0 max-w-3xl flex-col gap-2">
    <header class="flex shrink-0 items-center justify-between">
      <div>
        <h1 class="text-lg font-semibold">Диспетчер</h1>
      </div>
      <Button
        variant="outline"
        size="icon"
        aria-label="Обновить сообщения"
        :disabled="loading"
        @click="load()"
        ><RefreshCw class="size-4" :class="{ 'animate-spin': loading }"
      /></Button>
    </header>
    <Dialog v-model:open="offerOpen"
      ><DialogContent
        ><DialogTitle class="sr-only">Новый заказ</DialogTitle
        ><DialogDescription class="sr-only"
          >Выберите время прибытия и подтвердите заказ.</DialogDescription
        ><IncomingOrder /></DialogContent
    ></Dialog>
    <p
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
    >
      {{ error }}
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
