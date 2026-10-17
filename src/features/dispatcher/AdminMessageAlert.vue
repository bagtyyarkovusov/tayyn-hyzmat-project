<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { X } from "lucide-vue-next";
import { adminApi } from "@/shared/api";
import { adminSession } from "@/features/auth/session";
import { Button } from "@/shared/ui/button";

type IncomingMessage = {
  id: string;
  driverId: string;
  senderName?: string | null;
  body: string;
  sentAt?: string | Date;
};

const route = useRoute();
const router = useRouter();
const message = ref<IncomingMessage | null>(null);
const unreadDrivers = ref(new Set<string>());
const seen = new Set<string>();
let audio: HTMLAudioElement | null = null;
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

function isIncoming(value: unknown): value is IncomingMessage {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<IncomingMessage>;
  return Boolean(
    typeof payload.id === "string" &&
    typeof payload.driverId === "string" &&
    typeof payload.body === "string",
  );
}

function playSound() {
  try {
    audio ??= new Audio("/notification.mp3");
    audio.currentTime = 0;
    void audio.play().catch(() => {
      // Browsers may block an unsolicited sound until the dispatcher interacts.
    });
  } catch {
    /* Audio is an enhancement; the visible alert remains authoritative. */
  }
}

function showIncoming(payload: unknown) {
  if (!isIncoming(payload) || seen.has(payload.id)) return;
  seen.add(payload.id);
  // Bound this tab-local deduplication set during long-running shifts.
  if (seen.size > 500) seen.delete(seen.values().next().value as string);
  if (activeDriverId.value === payload.driverId) return;
  activityRevision++;
  unreadDrivers.value = new Set(unreadDrivers.value).add(payload.driverId);
  message.value = payload;
  playSound();
  void refreshUnread();
}

async function refreshUnread() {
  const request = ++unreadRequest;
  const revision = activityRevision;
  try {
    const response = await adminApi.get<{ driverIds: string[] }>(
      "/admin/messages/unread",
    );
    if (!mounted || request !== unreadRequest || revision !== activityRevision)
      return;
    unreadDrivers.value = new Set(response.data.driverIds);
    if (message.value && !unreadDrivers.value.has(message.value.driverId))
      message.value = null;
  } catch {
    // Keep live alerts if the canonical unread snapshot is unavailable.
  }
}

function dismiss() {
  message.value = null;
}

function openConversation() {
  const driverId = message.value?.driverId;
  if (!driverId) return;
  message.value = null;
  void router.push(`/adminChat/${driverId}`);
}

onMounted(() => {
  mounted = true;
  stopMessage = adminSession.on("driver:message", showIncoming);
  stopRead = adminSession.on(
    "admin:messages-read",
    (payload: { driverId?: string }) => {
      if (!payload?.driverId) return;
      activityRevision++;
      // A read cursor may cover only older messages in this conversation.
      // Reconcile with the server instead of clearing newer unread alerts.
      void refreshUnread();
    },
  );
  stopConnect = adminSession.on("connect", () => void refreshUnread());
  void refreshUnread();
});

watch(activeDriverId, (driverId) => {
  if (driverId && message.value?.driverId === driverId) message.value = null;
});

onUnmounted(() => {
  mounted = false;
  unreadRequest++;
  stopMessage?.();
  stopRead?.();
  stopConnect?.();
  audio?.pause();
  audio = null;
});
</script>

<template>
  <div
    v-if="message && activeDriverId !== message.driverId"
    class="fixed inset-x-3 top-3 z-[70] mx-auto w-[calc(100%-1.5rem)] max-w-md"
  >
    <div
      role="alert"
      aria-label="Новое сообщение"
      class="rounded-xl border border-primary/30 bg-card/95 p-3 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-card/80"
    >
      <button
        type="button"
        class="flex w-full items-start gap-3 text-left"
        @click="openConversation"
      >
        <span
          class="mt-1 flex size-2.5 shrink-0 rounded-full bg-primary ring-4 ring-primary/15"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1">
          <span class="flex items-center justify-between gap-2">
            <span class="text-sm font-semibold">Новое сообщение</span>
            <span class="text-xs text-muted-foreground"
              >{{ unreadCount }} непрочитанных диалогов</span
            >
          </span>
          <span class="mt-1 block truncate text-sm font-medium">
            {{ message.senderName || "Водитель" }}
          </span>
          <span class="mt-0.5 block truncate text-sm text-muted-foreground">
            {{ message.body }}
          </span>
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon"
        class="absolute right-1.5 top-1.5 size-7"
        aria-label="Закрыть уведомление"
        @click="dismiss"
      >
        <X class="size-4" />
      </Button>
    </div>
  </div>
</template>
