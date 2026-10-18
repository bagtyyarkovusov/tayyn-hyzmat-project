import { reactive, readonly } from "vue";
import type { Order } from "./model";
import { nativeAndroid } from "./nativeShift";
import { nativeNotifications } from "./nativeNotifications";
let audio: HTMLAudioElement | null = null;
let notification: Notification | null = null;
let attempt: string | null = null;
let deadline: ReturnType<typeof setTimeout> | undefined;
const seenAttempts = new Map<string, number>();
const chatNotifications = new Map<string, Notification>();
function player() {
  return (audio ??= new Audio("/notification.mp3"));
}
const state = reactive({
  permission: "unsupported" as NotificationPermission | "unsupported",
  soundReady: false,
  pending: false,
});
export const alertState = readonly(state);
export function resetAlerts() {
  // Native session replacement resets its own persisted ledger. Cold recovery
  // of the same installation must retain those already delivered alerts.
  if (!nativeAndroid) {
    closeOrderAlerts();
    closeChatAlerts();
  }
}
export function syncAlertPermission() {
  if (nativeAndroid) {
    void nativeNotifications
      .status()
      .then((result) => {
        state.permission =
          result.permission === "prompt" ? "default" : result.permission;
        state.soundReady = state.permission === "granted";
      })
      .catch(() => {
        state.permission = "denied";
        state.soundReady = false;
      });
    return;
  }
  state.permission =
    typeof Notification === "undefined"
      ? "unsupported"
      : Notification.permission;
}
export async function enableOrderAlerts() {
  if (state.pending) return;
  state.pending = true;
  if (nativeAndroid) {
    try {
      const result = await nativeNotifications.requestPermissions();
      state.permission =
        result.permission === "prompt" ? "default" : result.permission;
      state.soundReady = state.permission === "granted";
    } catch {
      state.permission = "denied";
      state.soundReady = false;
    } finally {
      state.pending = false;
    }
    return;
  }
  const sound = player();
  // Start both requests during the user gesture; neither grants the other.
  const audioReady = sound
    .play()
    .then(() => {
      sound.pause();
      sound.currentTime = 0;
      state.soundReady = true;
    })
    .catch(() => {
      state.soundReady = false;
    });
  try {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    )
      await Notification.requestPermission();
    await audioReady;
  } catch {
    await audioReady;
  } finally {
    syncAlertPermission();
    state.pending = false;
  }
}
export function closeOrderAlerts(eventIds?: string[]) {
  if (nativeAndroid)
    void nativeNotifications
      .clear({ channel: "orders", eventIds })
      .catch(() => {});
  if (eventIds && (!attempt || !eventIds.includes(attempt))) return;
  clearTimeout(deadline);
  attempt = null;
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
  if (notification) {
    notification.onclick = null;
    notification.close();
  }
  notification = null;
}
export function reconcileOrderAlerts(eventIds: string[]) {
  if (nativeAndroid)
    void nativeNotifications.reconcileOrders({ eventIds }).catch(() => {});
  if (attempt && !eventIds.includes(attempt)) closeOrderAlerts([attempt]);
}
export interface OfferAlertAttempt {
  eventId: string;
  expiresAt: string;
  remainingMs?: number;
}
export function notifyOrder(order: Order, offer?: OfferAlertAttempt) {
  // Android has one sound owner across WebView, Socket.IO, polling and FCM.
  if (nativeAndroid || !offer?.eventId) return;
  const now = Date.now();
  for (const [id, expiry] of seenAttempts)
    if (expiry <= now) seenAttempts.delete(id);
  const expiry = Date.parse(offer.expiresAt);
  const remaining = Math.min(
    20000,
    offer.remainingMs ?? expiry - now,
    expiry - now,
  );
  if (
    !Number.isFinite(remaining) ||
    remaining <= 0 ||
    seenAttempts.has(offer.eventId)
  )
    return;
  closeOrderAlerts();
  attempt = offer.eventId;
  seenAttempts.set(offer.eventId, expiry);
  // Schedule before play resolves, so a pending autoplay promise cannot
  // extend the canonical deadline or restart after local dismissal.
  deadline = setTimeout(() => closeOrderAlerts([offer.eventId]), remaining);
  const sound = player();
  sound.loop = false;
  void sound
    .play()
    .then(() => {
      if (attempt !== offer.eventId) sound.pause();
    })
    .catch(() => {
      state.soundReady = false;
    });
  if (
    document.hidden &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    try {
      notification = new Notification("Новый заказ", {
        body: [order.pickupAddress, order.dropoffAddress]
          .filter(Boolean)
          .join(" → "),
        tag: offer.eventId,
        silent: true,
      });
      notification.onclick = () => {
        window.focus();
        closeOrderAlerts([offer.eventId]);
      };
      notification.onclose = () => closeOrderAlerts([offer.eventId]);
    } catch {
      /* Mobile browsers may require a service worker. */
    }
  }
}

export function closeChatAlerts(eventIds?: string[]) {
  if (nativeAndroid)
    void nativeNotifications.clear({ channel: "chat", eventIds });
  const ids = eventIds ?? [...chatNotifications.keys()];
  for (const id of ids) {
    const alert = chatNotifications.get(id);
    if (alert) {
      alert.onclick = null;
      alert.close();
    }
    chatNotifications.delete(id);
  }
}
/** Show a dispatcher message outside the chat view. The native renderer owns
 * Android delivery; browsers use OS permission. `body` is deliberately passed through so the driver can identify
 * the message without opening the chat first. */
export function notifyChat(body: string, eventId: string) {
  if (nativeAndroid) return;
  // Chat has its own short player and cannot touch the offer music.
  void new Audio("/chat-notification.mp3").play().catch(() => {});
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    try {
      const alert = new Notification("Диспетчер", {
        body,
        tag: eventId,
        silent: true,
      });
      chatNotifications.set(eventId, alert);
      alert.onclick = () => {
        window.focus();
        alert.close();
        window.location.assign("/driverChat");
      };
    } catch {
      /* Mobile browser may require a service worker; permission status explains foreground limitation. */
    }
  }
}

export async function openNotificationSettings() {
  if (nativeAndroid) await nativeNotifications.settings();
}
