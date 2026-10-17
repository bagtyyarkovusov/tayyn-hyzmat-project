import { reactive, readonly } from "vue";
import type { Order } from "./model";
import { nativeAndroid } from "./nativeShift";
import { nativeNotifications } from "./nativeNotifications";
let audio: HTMLAudioElement | null = null;
let notification: Notification | null = null;
const chatNotifications = new Map<string, Notification>();
function player() {
  return (audio ??= new Audio("/notification.mp3"));
}
const state = reactive({
  permission: "unsupported" as NotificationPermission | "unsupported",
  soundReady: false,
  pending: false,
  enabled: true,
});
export const alertState = readonly(state);
export function setAlertsEnabled(enabled: boolean) {
  state.enabled = enabled;
  if (!enabled) {
    closeOrderAlerts();
    closeChatAlerts();
  }
}
export function resetAlerts() {
  // Native session replacement resets its own persisted ledger. Cold recovery
  // of the same installation must retain those already delivered alerts.
  if (!nativeAndroid) {
    closeOrderAlerts();
    closeChatAlerts();
  }
  setAlertsEnabled(true);
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
      if (state.permission === "denied") await nativeNotifications.settings();
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
export function closeOrderAlerts() {
  if (nativeAndroid) void nativeNotifications.clear({ channel: "orders" });
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
export function notifyOrder(order: Order) {
  if (nativeAndroid || !state.enabled) return;
  void player()
    .play()
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
        tag: "order-new",
      });
      notification.onclick = () => {
        window.focus();
        notification?.close();
      };
    } catch {
      /* Some mobile browsers expose Notification but reject its constructor. */
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
 * Android delivery; browsers use the permission that the profile switch
 * enabled. `body` is deliberately passed through so the driver can identify
 * the message without opening the chat first. */
export function notifyChat(body: string, eventId: string) {
  if (nativeAndroid || !state.enabled) return;
  void player()
    .play()
    .catch(() => {});
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    try {
      const alert = new Notification("Диспетчер", {
        body,
        tag: eventId,
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
