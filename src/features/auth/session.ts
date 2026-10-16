import { reactive } from "vue";
import { stopNativeShift } from "@/features/driver/nativeShift";
import { io, type Socket } from "socket.io-client";
import {
  ApiError,
  apiBase,
  adminApi,
  driverApi,
  publicRequest,
  refreshRole,
  tokens,
  type Role,
  type SessionPayload,
  type User,
} from "@/shared/api";
function createSession(role: Role) {
  const storedUser = (): User | null => {
    try {
      return JSON.parse(localStorage.getItem(`tayyn.${role}.user`) || "null");
    } catch {
      return null;
    }
  };
  const state = reactive({
    user: storedUser(),
    accessToken: tokens.access(role),
    connected: false,
    restoring: false,
    verificationError: "",
    message: "",
  });
  let socket: Socket | null = null;
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  function emit(event: string, ...args: any[]) {
    for (const listener of listeners.get(event) || []) listener(...args);
  }
  function disconnect() {
    socket?.removeAllListeners();
    socket?.disconnect();
    socket = null;
    state.connected = false;
  }
  function connect() {
    disconnect();
    if (!state.accessToken) return;
    socket = io(
      import.meta.env.VITE_SOCKET_URL ||
        import.meta.env.VUE_APP_SOCKET_URL ||
        window.location.origin,
      {
        auth: (callback) => callback({ token: tokens.access(role) }),
        transports: ["websocket", "polling"],
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
      },
    );
    socket.on("connect", () => {
      state.connected = true;
      emit("connect");
    });
    socket.on("disconnect", () => {
      state.connected = false;
      emit("disconnect");
    });
    const connectedSocket = socket;
    const generation = tokens.generation(role);
    socket.on("connect_error", async (error: Error) => {
      state.connected = false;
      if (error.message !== "unauthorized") return;
      try {
        await refreshRole(role);
        if (
          socket === connectedSocket &&
          generation === tokens.generation(role)
        )
          socket.connect();
      } catch {
        if (
          socket === connectedSocket &&
          generation === tokens.generation(role)
        )
          disconnect();
      }
    });
    socket.onAny((event, ...args) => emit(event, ...args));
    socket.on("driver:blocked", () => {
      state.message = "Доступ ограничен диспетчером.";
      tokens.clear(role);
    });
    socket.on("session:revoked", () => {
      state.message = "Сессия завершена. Войдите снова.";
      tokens.clear(role);
    });
  }
  window.addEventListener(`session:${role}`, (event) => {
    const payload = (event as CustomEvent<SessionPayload | null>).detail;
    state.accessToken = payload?.accessToken || "";
    state.user = payload?.user || null;
    if (!payload) disconnect();
  });
  const client = role === "admin" ? adminApi : driverApi;
  async function login(phone: string, password: string) {
    let deviceId = localStorage.getItem("openride.driver.deviceId");
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem("openride.driver.deviceId", deviceId);
    }
    const payload = await publicRequest<SessionPayload>("/auth/login", {
      phone,
      password,
      ...(role === "driver"
        ? { deviceId, deviceLabel: navigator.userAgent.slice(0, 200) }
        : {}),
    });
    if (payload.user.role !== (role === "admin" ? "ADMIN" : "DRIVER")) {
      await publicRequest("/auth/logout", {
        refreshToken: payload.refreshToken,
      }).catch(() => {});
      throw new Error("Этот аккаунт предназначен для другой роли.");
    }
    tokens.set(role, payload);
    state.message = "";
    state.verificationError = "";
    connect();
  }
  async function logout() {
    const refreshToken = tokens.refresh(role);
    if (role === "driver") {
      void stopNativeShift();
      // The logout endpoint releases only this device's shift. A spectator
      // must never send a global Offline action for another device.
    }
    disconnect();
    tokens.clear(role);
    if (refreshToken)
      await publicRequest("/auth/logout", { refreshToken }).catch(() => {});
  }
  let restoring: Promise<void> | null = null;
  function restore(): Promise<void> {
    if (restoring) return restoring;
    if (!tokens.access(role)) return Promise.resolve();
    state.restoring = true;
    state.verificationError = "";
    const generation = tokens.generation(role);
    restoring = client
      .get(role === "admin" ? "/admin/drivers?limit=1" : "/driver/profile")
      .then(() => {
        if (generation === tokens.generation(role)) connect();
      })
      .catch((error: unknown) => {
        if (generation !== tokens.generation(role)) return;
        if (error instanceof ApiError && [401, 403].includes(error.status))
          tokens.clear(role);
        else
          state.verificationError =
            "Не удалось проверить подключение. Данные входа сохранены.";
      })
      .finally(() => {
        state.restoring = false;
        restoring = null;
      });
    return restoring;
  }
  return {
    state,
    login,
    logout,
    restore,
    on(event: string, listener: (...args: any[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return () => listeners.get(event)?.delete(listener);
    },
  };
}
export const adminSession = createSession("admin");
export const driverSession = createSession("driver");
