import { reactive, readonly } from "vue";
import type { Order } from "./model";
import { nativeAndroid, nativeShift } from "./nativeShift";
const permissionState = reactive({ message: "", blocked: false });
export const alertPermission = readonly(permissionState);
let audio: HTMLAudioElement | null = null;
let notification: Notification | null = null;
function player() {
  return (audio ??= new Audio("/notification.mp3"));
}
export async function enableOrderAlerts() {
  permissionState.message = "";
  permissionState.blocked = false;
  if (nativeAndroid) {
    const result = await nativeShift.permissions().catch(() => null);
    permissionState.blocked = !result?.ordersEnabled || !result?.chatEnabled;
    permissionState.message = permissionState.blocked
      ? "Разрешите уведомления о заказах и сообщениях в настройках приложения."
      : "Уведомления о заказах и сообщениях включены.";
    return;
  }
  try {
    const sound = player();
    await sound.play();
    sound.pause();
    sound.currentTime = 0;
  } catch {
    permissionState.message =
      "Браузер не разрешил звук. Нажмите колокольчик ещё раз.";
  }
  if (typeof Notification === "undefined") {
    permissionState.message ||=
      "Этот браузер не поддерживает системные уведомления. Держите приложение открытым.";
    return;
  }
  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
  permissionState.blocked = permission !== "granted";
  permissionState.message ||= permissionState.blocked
    ? "Разрешите уведомления в настройках сайта. В браузере держите приложение открытым."
    : "Уведомления включены. В браузере держите приложение открытым.";
}
export async function openNotificationSettings() {
  if (nativeAndroid) await nativeShift.settings();
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
    .catch(() => {});
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
