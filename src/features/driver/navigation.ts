import { Capacitor, registerPlugin } from "@capacitor/core";
import type { Order } from "./model";

interface NavigationTarget {
  lat: number;
  lng: number;
  label: string;
  webUrl: string;
  appUrl: string;
}
const nativeNavigation = registerPlugin<{
  open(options: { lat: number; lng: number }): Promise<void>;
}>("DriverNavigation");

export function tripNavigation(order: Order | null): NavigationTarget | null {
  if (!order) return null;
  const dropoff = order.status === "STARTED";
  const rawLat = dropoff ? order.dropoffLat : order.pickupLat;
  const rawLng = dropoff ? order.dropoffLng : order.pickupLng;
  if (rawLat == null || rawLng == null || rawLat === "" || rawLng === "")
    return null;
  const lat = Number(rawLat),
    lng = Number(rawLng);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  )
    return null;
  const query = `rtext=~${lat},${lng}&rtt=auto`;
  return {
    lat,
    lng,
    label: dropoff ? "Маршрут до назначения" : "Маршрут до подачи",
    webUrl: `https://yandex.ru/maps/?${query}`,
    appUrl: `yandexmaps://maps.yandex.ru/?${query}`,
  };
}

export async function openTripNavigation(
  target: NavigationTarget,
): Promise<void> {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
    await nativeNavigation.open({ lat: target.lat, lng: target.lng });
    return;
  }
  // Browsers cannot query installed apps. Cancel the fallback permanently when
  // the browser is backgrounded, including when returning from navigation.
  const cancel = () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", hidden);
    window.removeEventListener("pagehide", cancel);
  };
  const hidden = () => {
    if (document.hidden) cancel();
  };
  const timer = window.setTimeout(() => {
    cancel();
    if (!document.hidden) window.location.assign(target.webUrl);
  }, 1500);
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("pagehide", cancel);
  window.location.assign(target.appUrl);
}
