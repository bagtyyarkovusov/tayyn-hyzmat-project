<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { X } from "lucide-vue-next";
import { adminApi } from "@/shared/api";
import { adminSession } from "@/features/auth/session";
import { Button } from "@/shared/ui/button";
import { createAdminChatSound } from "./adminChatSound";

type IncomingMessage = {
  id: string;
  driverId: string;
  senderName?: string | null;
  body: string;
  sentAt?: string | Date;
};

const route = useRoute();
const router = useRouter();
const messages = ref(new Map<string, IncomingMessage>());
const dismissed = new Map<string, string>();
const unreadDrivers = ref(new Set<string>());
const seen = new Set<string>();
const visible = ref(!document.hidden);
const sound = createAdminChatSound(() => adminSession.state.user?.id ?? null);
let stopMessage: (() => void) | undefined;
let stopRead: (() => void) | undefined;
let stopConnect: (() => void) | undefined;
let mounted = false;
let activityRevision = 0;
let unreadRequest = 0;

const activeDriverId = computed(() => {
  const match = route.path.match(/^\/adminChat\/([^/]+)/);
  return match?.[1] || null;
});
const unreadCount = computed(() => unreadDrivers.value.size);
const previews = computed(() =>
  [...messages.value.values()]
    .filter(
      (message) =>
        visibleDriverId.value !== message.driverId &&
        dismissed.get(message.driverId) !== message.id,
    )
    .sort(
      (a, b) =>
        String(b.sentAt ?? "").localeCompare(String(a.sentAt ?? "")) ||
        b.id.localeCompare(a.id),
    ),
);
const visiblePreviews = computed(() => previews.value.slice(0, 3));
const visibleDriverId = computed(() =>
  visible.value ? activeDriverId.value : null,
);

function isIncoming(value: unknown): value is IncomingMessage {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<IncomingMessage>;
  return Boolean(
    typeof payload.id === "string" &&
    typeof payload.driverId === "string" &&
    typeof payload.body === "string",
  );
}

function showIncoming(payload: unknown) {
  if (!isIncoming(payload) || seen.has(payload.id)) return;
  seen.add(payload.id);
  // Bound this tab-local deduplication set during long-running shifts.
  if (seen.size > 500) seen.delete(seen.values().next().value as string);
  if (visibleDriverId.value === payload.driverId) return;
  activityRevision++;
  unreadDrivers.value = new Set(unreadDrivers.value).add(payload.driverId);
  const previous = messages.value.get(payload.driverId);
  if (previous) sound.cancel(previous.id);
  messages.value = new Map(messages.value).set(payload.driverId, payload);
  void sound.play(
    payload.id,
    () =>
      mounted && previews.value.some((message) => message.id === payload.id),
  );
  void refreshUnread();
}

async function refreshUnread() {
  const request = ++unreadRequest;
  const revision = activityRevision;
  try {
    const response = await adminApi.get<{
      driverIds: string[];
      items: {
        driverId: string;
        driverName: string;
        message: { id: string; body: string; sentAt: string };
      }[];
    }>("/admin/messages/unread");
    if (!mounted || request !== unreadRequest || revision !== activityRevision)
      return;
    unreadDrivers.value = new Set(response.data.driverIds);
    const next = new Map<string, IncomingMessage>();
    for (const item of response.data.items) {
      next.set(item.driverId, {
        ...item.message,
        driverId: item.driverId,
        senderName: item.driverName,
      });
    }
    for (const previous of messages.value.values()) {
      if (next.get(previous.driverId)?.id !== previous.id)
        sound.cancel(previous.id);
    }
    messages.value = next;
  } catch {
    // Keep live alerts if the canonical unread snapshot is unavailable.
  }
}

function dismiss(message: IncomingMessage) {
  sound.cancel(message.id);
  dismissed.set(message.driverId, message.id);
  messages.value = new Map(messages.value);
}

function openConversation(message: IncomingMessage) {
  dismiss(message);
  void router.push(`/adminChat/${message.driverId}`);
}

function visibilityChanged() {
  visible.value = !document.hidden;
}

onMounted(() => {
  mounted = true;
  document.addEventListener("visibilitychange", visibilityChanged);
  stopMessage = adminSession.on("driver:message", showIncoming);
  stopRead = adminSession.on(
    "admin:messages-read",
    (payload: { driverId?: string; throughMessageId?: string }) => {
      if (!payload?.driverId) return;
      activityRevision++;
      if (payload.throughMessageId) sound.cancel(payload.throughMessageId);
      // A read cursor may cover only older messages in this conversation.
      // Reconcile with the server instead of clearing newer unread alerts.
      void refreshUnread();
    },
  );
  stopConnect = adminSession.on("connect", () => void refreshUnread());
  void refreshUnread();
});

watch(visibleDriverId, (driverId) => {
  const message = driverId ? messages.value.get(driverId) : undefined;
  if (message) dismiss(message);
});

onUnmounted(() => {
  mounted = false;
  unreadRequest++;
  stopMessage?.();
  stopRead?.();
  stopConnect?.();
  document.removeEventListener("visibilitychange", visibilityChanged);
  sound.dispose();
});
</script>

<template>
  <section
    v-if="visiblePreviews.length"
    role="alert"
    aria-label="Новое сообщение"
    class="flex max-h-[20dvh] min-w-0 flex-col border-t p-3 md:max-h-[40dvh] first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0"
  >
    <header
      class="flex shrink-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1"
    >
      <h2 class="text-sm font-semibold">Новое сообщение</h2>
      <span class="text-xs text-muted-foreground"
        >{{ unreadCount }} непрочитанных диалогов</span
      >
    </header>
    <ul class="mt-1 min-h-0 divide-y overflow-y-auto overscroll-contain">
      <li
        v-for="message in visiblePreviews"
        :key="message.driverId"
        class="flex items-start gap-1"
      >
        <button
          type="button"
          class="min-h-12 min-w-0 flex-1 rounded-md px-1 py-2 text-left hover:bg-secondary focus-visible:outline-2 focus-visible:outline-primary"
          @click="openConversation(message)"
        >
          <span class="block break-words text-sm font-semibold">{{
            message.senderName || "Водитель"
          }}</span>
          <span
            class="mt-0.5 line-clamp-2 break-words text-sm text-muted-foreground"
            >{{ message.body }}</span
          >
        </button>
        <Button
          variant="ghost"
          size="icon"
          class="size-11 shrink-0"
          aria-label="Закрыть уведомление"
          :title="`Закрыть уведомление: ${message.senderName || 'Водитель'}`"
          @click="dismiss(message)"
          ><X class="size-4"
        /></Button>
      </li>
    </ul>
    <RouterLink
      v-if="unreadCount > 3"
      to="/adminChat"
      class="inline-flex min-h-11 shrink-0 items-center px-1 text-sm font-semibold underline underline-offset-4"
      >Все сообщения · {{ unreadCount }}</RouterLink
    >
  </section>
</template>
