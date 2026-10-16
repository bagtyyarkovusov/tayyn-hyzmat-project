import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import { apiBase, refreshRole, tokens } from "@/shared/api";
export interface NativeShiftStatus {
  running: boolean;
  userId: string;
  phase: "off" | "connecting" | "online" | "reconnecting" | "gps-unavailable";
  detail: string;
  lastReportAt: number;
  stopSequence: number;
  lat: number;
  lng: number;
  accuracy: number;
  ordersEnabled: boolean;
  chatEnabled: boolean;
  locationGranted?: boolean;
}
interface NativeShiftPlugin {
  permissions(): Promise<NativeShiftStatus>;
  status(): Promise<NativeShiftStatus>;
  location(): Promise<{
    lat: number;
    lng: number;
    accuracy: number;
    timestamp: number;
  }>;
  start(options: {
    apiBase: string;
    shiftToken: string;
    leaseDurationMs: number;
    userId: string;
  }): Promise<void>;
  stop(options?: { shiftToken: string }): Promise<void>;
  clear(options: { channel: "orders" | "chat" }): Promise<void>;
  settings(): Promise<void>;
  notificationTarget(): Promise<{ channel: string }>;
  addListener(
    event: "notificationTarget",
    callback: (event: { channel: string }) => void,
  ): Promise<PluginListenerHandle>;
}
export const nativeAndroid =
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
export const nativeShift = registerPlugin<NativeShiftPlugin>("DriverShift");
function storedUserId(): string {
  try {
    return (
      JSON.parse(localStorage.getItem("tayyn.driver.user") || "null")?.id || ""
    );
  } catch {
    return "";
  }
}
let generation = 0;
export async function startNativeShift() {
  if (!nativeAndroid) return;
  const current = ++generation;
  const permission = await nativeShift.permissions();
  if (current !== generation) throw new Error("Смена отменена.");
  if (
    !permission.locationGranted ||
    !permission.ordersEnabled ||
    !permission.chatEnabled
  )
    throw new Error(
      "Разрешите точный GPS и уведомления о заказах и сообщениях в настройках приложения.",
    );
  async function requestCredential(
    retry = true,
  ): Promise<{ shiftToken: string }> {
    // Rebuild the refresh credential after access-token rotation instead of retrying a stale body.
    const response = await fetch(`${apiBase}/driver/shift`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.access("driver")}`,
      },
      body: JSON.stringify({
        deviceId: localStorage.getItem("openride.driver.deviceId"),
        refreshToken: tokens.refresh("driver"),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401 && retry && current === generation) {
      await refreshRole("driver");
      if (current !== generation) throw new Error("Смена отменена.");
      return requestCredential(false);
    }
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result?.message || result?.error?.message || "Не удалось начать смену.",
      );
    return result;
  }
  const data = await requestCredential();
  const revokeCredential = () =>
    fetch(`${apiBase}/native-shift/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${data.shiftToken}` },
    }).catch(() => {});
  if (current !== generation) {
    await revokeCredential();
    throw new Error("Смена отменена.");
  }
  try {
    await nativeShift.start({
      apiBase,
      shiftToken: data.shiftToken,
      leaseDurationMs: 60000,
      userId: storedUserId() || "",
    });
    if (current !== generation) {
      await nativeShift.stop({ shiftToken: data.shiftToken });
      await revokeCredential();
    }
  } catch (error) {
    await revokeCredential();
    throw error;
  }
}
export async function stopNativeShift() {
  generation++;
  if (nativeAndroid) await nativeShift.stop().catch(() => {});
}
// Explicit offline/logout stops service even if the WebView session has already been cleared.
let userId = storedUserId();
window.addEventListener("session:driver", (event) => {
  const nextId = (event as CustomEvent).detail?.user?.id;
  if (!nextId || (userId && nextId !== userId)) void stopNativeShift();
  userId = nextId;
});
