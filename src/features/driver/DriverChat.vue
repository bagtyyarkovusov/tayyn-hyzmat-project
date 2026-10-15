<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { Send, RefreshCw } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";
import { driverApi, errorMessage } from "@/shared/api";
import { driverSession } from "@/features/auth/session";
import { useDriver } from "./useDriver";
import { date, type Message, type Page } from "./model";
const { state } = useDriver();
const messages = ref<Message[]>([]),
  draft = ref(""),
  error = ref(""),
  loading = ref(false),
  sending = ref(false),
  page = ref(1),
  total = ref(0),
  end = ref<HTMLElement | null>(null);
let alive = true;
async function load(older = false) {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const next = older ? page.value + 1 : 1;
    const { data } = await driverApi.get<Page<Message>>("/driver/messages", {
      params: { page: next, limit: 50 },
    });
    if (!alive) return;
    page.value = next;
    total.value = data.total;
    const combined = older ? [...data.items, ...messages.value] : data.items;
    messages.value = [...new Map(combined.map((m) => [m.id, m])).values()].sort(
      (a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt),
    );
    await driverApi.post("/driver/messages/read");
    if (!older) {
      await nextTick();
      end.value?.scrollIntoView({ block: "nearest" });
    }
  } catch (e) {
    if (alive) error.value = errorMessage(e);
  } finally {
    loading.value = false;
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
    if (!messages.value.some((m) => m.id === data.id))
      messages.value.push(data);
    draft.value = "";
    await nextTick();
    end.value?.scrollIntoView({ block: "nearest" });
  } catch (e) {
    error.value = errorMessage(e);
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
  <div class="mx-auto flex max-w-3xl flex-col gap-4">
    <header class="flex items-center justify-between">
      <div>
        <h1 class="page-heading">Диспетчер</h1>
        <p class="muted mt-1 text-sm">Личная переписка и общие объявления.</p>
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
    <p
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
    >
      {{ error }}
    </p>
    <section
      class="min-h-64 space-y-4 rounded-xl border bg-card p-4"
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
      <div ref="end" />
    </section>
    <form
      class="sticky bottom-20 space-y-2 rounded-xl border bg-background p-3 md:bottom-4"
      @submit.prevent="send"
    >
      <label for="driver-message" class="field-label"
        >Сообщение диспетчеру</label
      ><Textarea
        id="driver-message"
        v-model="draft"
        rows="3"
        maxlength="2000"
        placeholder="Чем можем помочь?"
        :disabled="sending"
      />
      <div class="flex items-center justify-between gap-3">
        <span class="muted text-xs tabular-nums">{{ draft.length }} / 2000</span
        ><Button type="submit" :disabled="sending || !draft.trim()"
          ><Send class="size-4" />{{
            sending ? "Отправляем…" : "Отправить"
          }}</Button
        >
      </div>
    </form>
  </div>
</template>
