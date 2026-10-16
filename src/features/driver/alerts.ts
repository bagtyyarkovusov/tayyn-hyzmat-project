import { reactive, readonly } from "vue";
import type { Order } from "./model";
import { nativeAndroid, nativeShift } from "./nativeShift";
let audio: HTMLAudioElement | null = null;
let notification: Notification | null = null;
function player() {
  return (audio ??= new Audio("/notification.mp3"));
}
const state = reactive({
  permission: "unsupported" as NotificationPermission | "unsupported",
  soundReady: false,
  pending: false,
});
export const alertState = readonly(state);
export function syncAlertPermission() {
  if (nativeAndroid) {
    void nativeShift
      .status()
      .then((result) => {
        state.permission =
          result.ordersEnabled && result.chatEnabled ? "granted" : "denied";
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
      const result = await nativeShift.permissions();
      state.permission =
        result.ordersEnabled && result.chatEnabled ? "granted" : "denied";
      state.soundReady = state.permission === "granted";
      if (state.permission === "denied") await nativeShift.settings();
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
  if (nativeAndroid) void nativeShift.clear({ channel: "orders" });
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
  notification?.close();
  notification = null;
}
export function notifyOrder(order: Order) {
  if (nativeAndroid) return;
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

export function closeChatAlerts() {
  if (nativeAndroid) void nativeShift.clear({ channel: "chat" });
}
export function notifyChat() {
  if (nativeAndroid || !document.hidden) return;
  void player()
    .play()
    .catch(() => {});
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    try {
      new Notification("Диспетчер", {
        body: "Новое сообщение. Откройте чат.",
        tag: "driver-chat",
      });
    } catch {
      /* Mobile browser may require a service worker; permission status explains foreground limitation. */
    }
  }
}

export async function openNotificationSettings() {
  if (nativeAndroid) await nativeShift.settings();
}
