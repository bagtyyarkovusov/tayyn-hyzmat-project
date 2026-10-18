import {
  onMounted,
  onUnmounted,
  reactive,
  readonly,
  ref,
  watch,
  type Ref,
} from "vue";
import { driverSession } from "@/features/auth/session";
import { driverApi, apiBase, errorMessage } from "@/shared/api";
import { nativeAndroid } from "./nativeShift";
import { nativeNotifications } from "./nativeNotifications";
import {
  syncAlertPermission,
  resetAlerts,
  notifyChat,
  closeChatAlerts,
} from "./alerts";

interface Settings {
  installationId: string;
  transportConfigured: boolean;
}
const state = reactive({
  loading: false,
  error: "",
  installationId: "",
  transportConfigured: false,
});
export const notificationSettings = readonly(state);
let generation = 0;
let operation = 0;
let eventCleanup: (() => void) | undefined;
let tokenListener: { remove: () => Promise<void> } | undefined;
let nativeOperations = Promise.resolve();
let configurationOperations = Promise.resolve();
const seenEvents = new Set<string>();
const pendingEvents = new Set<string>();
const MAX_SEEN_EVENTS = 500;

function nativeOperation(current: number, action: () => Promise<void>) {
  const next = nativeOperations
    .catch(() => {})
    .then(async () => {
      if (current === generation) await action();
    });
  nativeOperations = next;
  return next;
}

// Registration rotates the server capability. Keep its HTTP request and native
// installation together, with installation setup to reject stale account responses.
function configurationOperation(current: number, action: () => Promise<void>) {
  const next = configurationOperations
    .catch(() => {})
    .then(async () => {
      if (current === generation && driverSession.state.user) await action();
    });
  configurationOperations = next;
  return next;
}

interface NotificationEvent {
  id: string;
  channel: "chat" | "orders";
  title: string;
  body: string;
  expiresAt?: string;
  orderId?: string;
  messageId?: string;
}
interface NotificationEnvelope {
  installationId?: string;
  event?: NotificationEvent;
}

function rememberEvent(id: string) {
  if (seenEvents.has(id) || pendingEvents.has(id)) return false;
  pendingEvents.add(id);
  return true;
}
function finishEvent(id: string) {
  pendingEvents.delete(id);
  seenEvents.add(id);
  if (seenEvents.size > MAX_SEEN_EVENTS)
    seenEvents.delete(seenEvents.values().next().value as string);
}

async function acknowledge(eventId: string, current: number) {
  if (current !== generation || !driverSession.state.user) return false;
  try {
    await driverApi.post("/driver/notifications/ack", { eventId });
    return true;
  } catch {
    return false;
  }
}

function foreground() {
  return document.visibilityState === "visible";
}

async function handleNotification(
  payload: unknown,
  chatVisible: Ref<boolean>,
  current: number,
) {
  const envelope = payload as NotificationEnvelope | undefined;
  const event = envelope?.event;
  if (
    !event?.id ||
    !event.channel ||
    (state.installationId &&
      envelope?.installationId &&
      envelope.installationId !== state.installationId) ||
    current !== generation ||
    !driverSession.state.user
  )
    return;
  if (seenEvents.has(event.id)) {
    // Retry a failed browser ack without playing the notification again.
    if (!nativeAndroid) await acknowledge(event.id, current);
    return;
  }
  if (!rememberEvent(event.id)) return;
  // Events may sit in the native ledger while the app is suspended. They are
  // still acknowledged, but an expired order should not wake a stale popup.
  const expired = event.expiresAt && Date.parse(event.expiresAt) <= Date.now();
  const quietChat =
    event.channel === "chat" && chatVisible.value && foreground();
  // Browser order popups are rendered by useDriver from the order socket
  // event. The notification outbox event still needs an acknowledgement so
  // it does not get replayed every second.
  if (event.channel === "chat") {
    // DriverChat listens for this signal and reconciles its message history.
    window.dispatchEvent(
      new CustomEvent("driver:notification-chat", {
        detail: { messageId: event.messageId },
      }),
    );
    if (!quietChat && !expired) {
      if (nativeAndroid) {
        await nativeOperation(current, () =>
          nativeNotifications.deliver({ eventId: event.id }),
        );
      } else notifyChat(event.body, event.id);
    }
  } else if (!expired && nativeAndroid) {
    await nativeOperation(current, () =>
      nativeNotifications.deliver({ eventId: event.id }),
    );
  }
  // Native deliver verifies the canonical event and acknowledges it with the
  // capability token. Browser delivery uses the authenticated session.
  if (!nativeAndroid || quietChat || expired)
    await acknowledge(event.id, current);
  if (current === generation) finishEvent(event.id);
  else pendingEvents.delete(event.id);
}

async function updatePresence(chatVisible: Ref<boolean>) {
  if (!nativeAndroid || !driverSession.state.user) return;
  await nativeOperation(generation, () =>
    nativeNotifications.setPresence({
      chatVisible: chatVisible.value && foreground(),
      foreground: foreground(),
    }),
  ).catch(() => {});
}
function configureNative(current: number) {
  if (!nativeAndroid) return Promise.resolve();
  return configurationOperation(current, () =>
    configureNativeInstallation(current),
  );
}
async function configureNativeInstallation(current: number) {
  const native = await nativeNotifications.status();
  if (current !== generation || !driverSession.state.user) return;
  const { data } = await driverApi.post<
    Settings & { notificationToken: string }
  >("/driver/notifications/registration", {
    token: native.token ?? null,
  });
  if (current !== generation || !driverSession.state.user) return;
  state.installationId = data.installationId;
  state.transportConfigured = data.transportConfigured;
  const userId = driverSession.state.user.id;
  await nativeOperation(current, () =>
    nativeNotifications.configure({
      apiBase,
      notificationToken: data.notificationToken,
      userId,
      deviceId: localStorage.getItem("openride.driver.deviceId") ?? "",
    }),
  );
  if (current !== generation) return;
  await updatePresence(currentChatVisible);
  if (!tokenListener) {
    const listener = await nativeNotifications.addListener(
      "tokenChanged",
      () => {
        if (current === generation)
          void configureNative(current).catch(() => {});
      },
    );
    if (current === generation) tokenListener = listener;
    else await listener.remove();
  }
}
let currentChatVisible = ref(false) as Ref<boolean>;
export async function loadNotificationSettings() {
  const current = generation;
  const request = ++operation;
  state.loading = true;
  state.error = "";
  try {
    const { data } = await driverApi.get<Settings>(
      "/driver/notifications/settings",
    );
    if (
      current !== generation ||
      request !== operation ||
      !driverSession.state.user
    )
      return;
    state.installationId = data.installationId;
    state.transportConfigured = data.transportConfigured;
    await configureNative(current);
    if (current === generation) syncAlertPermission();
  } catch (error) {
    if (current === generation && request === operation)
      state.error = errorMessage(error);
  } finally {
    if (current === generation && request === operation) state.loading = false;
  }
}
export function useDriverNotifications(
  chatVisible: Ref<boolean>,
  verifiedDriverView: Ref<boolean>,
) {
  currentChatVisible = chatVisible;
  const onEvent = (payload: unknown) =>
    void handleNotification(payload, chatVisible, generation).catch(() => {
      const id = (payload as NotificationEnvelope | undefined)?.event?.id;
      if (id) pendingEvents.delete(id);
    });
  eventCleanup?.();
  const offEvent = driverSession.on("notification:event", onEvent);
  const offRead = driverSession.on("chat:read", (payload: unknown) => {
    const ids = (payload as { eventIds?: unknown } | undefined)?.eventIds;
    if (!Array.isArray(ids)) return;
    closeChatAlerts(ids.filter((id): id is string => typeof id === "string"));
  });
  eventCleanup = () => {
    offEvent();
    offRead();
  };
  const onVisibility = () => {
    if (verifiedDriverView.value) void updatePresence(chatVisible);
  };
  document.addEventListener("visibilitychange", onVisibility);
  const stop = watch(
    () => driverSession.state.user?.id,
    (userId, previousUserId) => {
      generation++;
      operation++;
      resetAlerts();
      state.installationId = "";
      state.error = "";
      state.loading = false;
      seenEvents.clear();
      pendingEvents.clear();
      if (nativeAndroid) {
        void tokenListener?.remove().catch(() => {});
        tokenListener = undefined;
        // Cold recovery of the same signed-in installation must retain the
        // native dedup ledger. Native configure also resets on user/device
        // replacement; an observed logout or account change resets here.
        if (previousUserId && previousUserId !== userId)
          void nativeOperation(generation, () =>
            nativeNotifications.reset(),
          ).catch(() => {});
      }
      if (userId && verifiedDriverView.value) void loadNotificationSettings();
    },
    { immediate: true },
  );
  onMounted(() => {
    syncAlertPermission();
    if (verifiedDriverView.value) void updatePresence(chatVisible);
  });
  const stopVerifiedWatch = watch(verifiedDriverView, (verified) => {
    if (verified && driverSession.state.user) {
      void loadNotificationSettings();
      void updatePresence(chatVisible);
    }
  });
  const stopChatWatch = watch(chatVisible, () => {
    if (verifiedDriverView.value) void updatePresence(chatVisible);
  });
  onUnmounted(() => {
    stop();
    stopChatWatch();
    stopVerifiedWatch();
    eventCleanup?.();
    eventCleanup = undefined;
    document.removeEventListener("visibilitychange", onVisibility);
    void tokenListener?.remove().catch(() => {});
    tokenListener = undefined;
  });
  return { chatVisible };
}
