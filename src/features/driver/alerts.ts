import type { Order } from "./model";
let audio: HTMLAudioElement | null = null;
let notification: Notification | null = null;
function player() {
  return (audio ??= new Audio("/notification.mp3"));
}
export function enableOrderAlerts() {
  const sound = player();
  void sound
    .play()
    .then(() => {
      sound.pause();
      sound.currentTime = 0;
    })
    .catch(() => {});
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "default"
  )
    void Notification.requestPermission();
}
export function closeOrderAlerts() {
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
  notification?.close();
  notification = null;
}
export function notifyOrder(order: Order) {
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
