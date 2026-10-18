import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
export interface NativeNotificationStatus {
  permission: "granted" | "denied" | "prompt";
  configured: boolean;
  token?: string;
}
interface DriverNotificationsPlugin {
  status(): Promise<NativeNotificationStatus>;
  requestPermissions(): Promise<NativeNotificationStatus>;
  configure(options: {
    apiBase: string;
    notificationToken: string;
    userId: string;
    deviceId: string;
  }): Promise<void>;
  reconcileOrders(options: { eventIds: string[] }): Promise<void>;
  setPresence(options: {
    chatVisible: boolean;
    foreground: boolean;
  }): Promise<void>;
  deliver(options: { eventId: string }): Promise<void>;
  clear(options: {
    channel: "chat" | "orders";
    eventIds?: string[];
  }): Promise<void>;
  reset(): Promise<void>;
  settings(): Promise<void>;
  addListener(
    event: "tokenChanged",
    callback: () => void,
  ): Promise<PluginListenerHandle>;
}
export const nativeNotifications = registerPlugin<DriverNotificationsPlugin>(
  "DriverNotifications",
);
