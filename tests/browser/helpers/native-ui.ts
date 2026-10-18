import type { BrowserContext } from "@playwright/test";

// The platform bridge is an external boundary. All account, shift and order
// operations below still reach the real disposable API and Socket.IO service.
export async function installNativeUiFixture(
  context: BrowserContext,
  userId: string,
) {
  await context.addInitScript((userId) => {
    const host = window as any;
    host.CapacitorCustomPlatform = { name: "android" };
    const listeners = new Map<string, (event: unknown) => void>();
    const replies: Array<{ requestId: number; result: string }> = [];
    let running = false;
    let sequence = 0;
    host.pressNativeBack = () => {
      listeners.get("DriverUi:back")?.({ requestId: ++sequence });
      return sequence;
    };
    host.nativeBackReplies = replies;
    host.nativeResetCount = 0;
    host.Capacitor = {
      PluginHeaders: [
        {
          name: "DriverUi",
          methods: ["ready", "respondBack", "resetBack", "detach", "theme"],
        },
        {
          name: "DriverShift",
          methods: [
            "permissions",
            "status",
            "location",
            "stop",
            "clear",
            "notificationTarget",
            "start",
          ],
        },
        {
          name: "DriverNotifications",
          methods: [
            "status",
            "requestPermissions",
            "configure",
            "setPresence",
            "deliver",
            "clear",
            "reconcileOrders",
            "reset",
            "settings",
          ],
        },
      ].map((plugin) => ({
        ...plugin,
        methods: [
          ...plugin.methods.map((name) => ({ name, rtype: "promise" })),
          { name: "addListener", rtype: "callback" },
          { name: "removeListener", rtype: "promise" },
        ],
      })),
      nativeCallback: (
        plugin: string,
        _method: string,
        options: { eventName: string },
        callback: (event: unknown) => void,
      ) => {
        listeners.set(`${plugin}:${options.eventName}`, callback);
        return `${plugin}:${options.eventName}`;
      },
      nativePromise: async (plugin: string, method: string, options: any) => {
        if (plugin === "DriverUi") {
          if (method === "ready")
            return { top: 24, right: 0, bottom: 24, left: 0 };
          if (method === "respondBack") replies.push(options);
          if (method === "resetBack") host.nativeResetCount++;
          return {};
        }
        if (plugin === "DriverNotifications")
          return method === "status" || method === "requestPermissions"
            ? { permission: "denied", configured: false }
            : {};
        if (method === "start") running = true;
        if (method === "stop") running = false;
        if (method === "location")
          return {
            lat: 37.96,
            lng: 58.32,
            accuracy: 10,
            timestamp: Date.now(),
          };
        return {
          running,
          userId,
          phase: running ? "online" : "off",
          detail: "",
          lastReportAt: Date.now(),
          lastFixAt: Date.now(),
          stopSequence: 0,
          leaseRemainingMs: 60_000,
          lat: 37.96,
          lng: 58.32,
          accuracy: 10,
          locationGranted: true,
          locationEnabled: true,
        };
      },
    };
  }, userId);
}
