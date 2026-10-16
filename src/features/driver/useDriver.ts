import { onMounted, onUnmounted, reactive, readonly, watch } from "vue";
import { driverApi, errorMessage, apiBase, tokens } from "@/shared/api";
import { driverSession } from "@/features/auth/session";
import { closeOrderAlerts, notifyOrder, notifyChat } from "./alerts";
import type { Balance, District, DriverProfile, Order } from "./model";
import {
  nativeAndroid,
  nativeShift,
  startNativeShift,
  stopNativeShift,
} from "./nativeShift";

const state = reactive({
  profile: null as DriverProfile | null,
  balance: null as Balance | null,
  districts: [] as District[],
  active: null as Order | null,
  incoming: null as Order | null,
  loading: false,
  busy: false,
  error: "",
  actionAttempt: 0,
  notice: "",
  gpsError: "",
  gpsPending: false,
  gpsReady: false,
  nativeRunning: false,
  nativeConnected: false,
  offerSeconds: 0,
  position: null as { lat: number; lng: number; accuracy: number } | null,
});
export const driverState = readonly(state);
let users = 0;
let refreshVersion = 0;
let districtSnapshotVersion = 0;
let sessionGeneration = 0;
let cleanups: Array<() => void> = [];
let gpsWatch: number | undefined;
let lastLocationSent = 0;
let locationSending = false;
let gpsTimer: ReturnType<typeof setInterval> | undefined;
let lastFixAt = 0;
let offlinePending = false;
let gpsEpoch = 0;
let offerTimer: ReturnType<typeof setInterval> | undefined;
let offerVersion = 0;
const GPS_MAX_AGE_MS = 60000;
function hasCurrentGps() {
  return (
    state.gpsReady &&
    Date.now() - lastLocationSent < GPS_MAX_AGE_MS &&
    Date.now() - lastFixAt < GPS_MAX_AGE_MS
  );
}
function hideAvailableOrders() {
  dismissIncoming();
  state.districts = state.districts.map((d) => ({
    ...d,
    activeOrders: 0,
    onlineDrivers: 0,
    freeDrivers: 0,
  }));
}
async function loseGps(message: string) {
  gpsEpoch++;
  state.gpsReady = false;
  state.gpsError = message;
  lastLocationSent = 0;
  hideAvailableOrders();
  if (!state.profile?.isOnline || offlinePending) return;
  state.profile.isOnline = false;
  offlinePending = true;
  const generation = sessionGeneration;
  try {
    await driverApi.post("/driver/status", { isOnline: false });
  } catch (error) {
    if (generation === sessionGeneration) state.error = errorMessage(error);
  } finally {
    if (generation === sessionGeneration) offlinePending = false;
  }
}
function dismissIncoming() {
  offerVersion++;
  if (offerTimer !== undefined) clearInterval(offerTimer);
  offerTimer = undefined;
  state.offerSeconds = 0;
  closeOrderAlerts();
  state.incoming = null;
}

function receivePrivateOffer(order: Order, sound = true) {
  if (
    !order.privateOfferExpiresAt ||
    !hasCurrentGps() ||
    !state.profile?.isOnline ||
    state.active
  )
    return;
  const expiresAt = Date.parse(order.privateOfferExpiresAt);
  const remainingMs = order.privateOfferRemainingMs;
  if (
    !Number.isFinite(expiresAt) ||
    typeof remainingMs !== "number" ||
    !Number.isFinite(remainingMs) ||
    remainingMs <= 0
  )
    return;
  const until = performance.now() + Math.min(20_000, remainingMs);
  if (
    state.incoming?.id === order.id &&
    state.incoming.privateOfferExpiresAt === order.privateOfferExpiresAt
  )
    return;
  dismissIncoming();
  state.incoming = order;
  const tick = () => {
    state.offerSeconds = Math.max(
      0,
      Math.ceil((until - performance.now()) / 1000),
    );
    if (!state.offerSeconds) dismissIncoming();
  };
  tick();
  offerTimer = setInterval(tick, 250);
  if (sound) notifyOrder(order);
}
async function recoverPrivateOffer() {
  const version = ++offerVersion;
  const generation = sessionGeneration;
  try {
    const { data } = await driverApi.get<Order | null>("/orders/private-offer");
    if (
      generation !== sessionGeneration ||
      version !== offerVersion ||
      !driverSession.state.accessToken
    )
      return;
    if (data) receivePrivateOffer(data, false);
    else if (state.incoming?.privateOfferExpiresAt) dismissIncoming();
  } catch (error) {
    if (generation === sessionGeneration && version === offerVersion)
      state.error = errorMessage(error);
  }
}
async function declinePrivateOffer() {
  const orderId = state.incoming?.id;
  if (!orderId || !state.incoming?.privateOfferExpiresAt) return;
  const generation = sessionGeneration;
  const privateOfferExpiresAt = state.incoming.privateOfferExpiresAt;
  await act(async () => {
    await driverApi.post("/orders/private-offer/decline", {
      orderId,
      privateOfferExpiresAt,
    });
    if (generation !== sessionGeneration) return;
    if (
      state.incoming?.id === orderId &&
      state.incoming.privateOfferExpiresAt === privateOfferExpiresAt
    )
      dismissIncoming();
    await refresh();
  });
}

// Session cleanup outlives route components, including navigation to login.
watch(
  () => driverSession.state.user?.id,
  () => {
    sessionGeneration++;
    gpsEpoch++;
    refreshVersion++;
    dismissIncoming();
    state.profile = null;
    state.balance = null;
    state.active = null;
    state.districts = [];
    state.error = "";
    state.notice = "";
    state.loading = false;
    state.busy = false;
    state.position = null;
    state.gpsReady = false;
    state.nativeRunning = false;
    state.nativeConnected = false;
    lastFixAt = 0;
    locationSending = false;
    offlinePending = false;
    if (gpsTimer !== undefined) clearInterval(gpsTimer);
    gpsTimer = undefined;
    lastLocationSent = 0;
    state.gpsError = "";
    state.gpsPending = false;
    if (gpsWatch !== undefined) navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = undefined;
  },
);
async function refresh() {
  const request = ++refreshVersion;
  const generation = sessionGeneration;
  const districtVersion = districtSnapshotVersion;
  const current = () =>
    request === refreshVersion &&
    generation === sessionGeneration &&
    Boolean(driverSession.state.accessToken);
  state.loading = true;
  state.error = "";
  try {
    const [profile, balance, districts, active] = await Promise.all([
      driverApi.get<DriverProfile>("/driver/profile"),
      driverApi.get<Balance>("/driver/balance"),
      driverApi.get<District[]>("/districts"),
      driverApi.get<Order | null>("/orders/current"),
    ]);
    if (!current()) return;
    state.profile = profile.data;
    state.balance = balance.data;
    if (districtVersion === districtSnapshotVersion)
      state.districts = districts.data;
    state.active = active.data;
    if (state.active) dismissIncoming();
    if (nativeAndroid) await synchronizeNative();
    if (!current()) return;
    if (!state.gpsReady) {
      hideAvailableOrders();
      if (state.profile.isOnline && !state.nativeRunning)
        void loseGps("Включите GPS перед выходом на линию.");
    } else if (state.profile.isOnline && !state.active) {
      await recoverPrivateOffer();
    }
  } catch (error) {
    if (current()) state.error = errorMessage(error);
  } finally {
    if (current()) state.loading = false;
  }
}
async function act(work: () => Promise<void>) {
  if (state.busy) return;
  const generation = sessionGeneration;
  state.busy = true;
  state.error = "";
  state.notice = "";
  state.actionAttempt++;
  try {
    await work();
  } catch (error) {
    if (generation === sessionGeneration) state.error = errorMessage(error);
  } finally {
    if (generation === sessionGeneration) state.busy = false;
  }
}
async function accept(orderId: string, etaMinutes: number) {
  if (!hasCurrentGps() || !state.profile?.isOnline) {
    dismissIncoming();
    state.error = "Включите GPS и выйдите на линию, чтобы принимать заказы.";
    return;
  }
  if (!driverSession.state.accessToken) {
    dismissIncoming();
    return;
  }
  const generation = sessionGeneration;
  const privateOfferExpiresAt =
    state.incoming?.id === orderId
      ? state.incoming.privateOfferExpiresAt
      : undefined;
  await act(async () => {
    const { data } = await driverApi.post<Order>(
      privateOfferExpiresAt ? "/orders/private-offer/accept" : "/orders/accept",
      {
        ...(privateOfferExpiresAt ? { privateOfferExpiresAt } : {}),
        orderId,
        etaMinutes,
      },
    );
    if (generation !== sessionGeneration) return;
    dismissIncoming();
    state.active = data;
    await refresh();
  });
}
async function transition(
  action: "waiting" | "start" | "complete" | "cancel",
  reason?: string,
) {
  if (!state.active) return;
  const orderId = state.active.id;
  await act(async () => {
    await driverApi.post(`/orders/${action}`, {
      orderId,
      ...(reason ? { reason } : {}),
    });
    await refresh();
    if (action === "complete") state.notice = "Поездка завершена.";
    if (action === "cancel") state.notice = "Заказ отменён.";
  });
}
function nativeAccountRequest() {
  const generation = sessionGeneration;
  const accessToken = tokens.access("driver");
  const current = () => generation === sessionGeneration;
  return {
    current,
    async post<T>(path: string, body: unknown): Promise<{ data: T }> {
      if (!current()) throw new Error("Сессия уже изменена.");
      const response = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!current()) throw new Error("Сессия уже изменена.");
      const data = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          data?.message ||
            data?.error?.message ||
            "Не удалось выполнить запрос.",
        );
      return { data: data as T };
    },
  };
}
async function setOnline() {
  if (!state.profile) return;
  const isOnline = !state.profile.isOnline;
  if (isOnline && !hasCurrentGps()) {
    state.gpsError = "Включите GPS перед выходом на линию.";
    return;
  }
  const account = nativeAccountRequest();
  await act(async () => {
    if (!isOnline) await stopNativeShift();
    if (!account.current()) return;
    await (nativeAndroid ? account : driverApi).post("/driver/status", {
      isOnline,
      isAvailable: isOnline,
    });
    if (!account.current()) return;
    if (isOnline && nativeAndroid) {
      try {
        await startNativeShift();
      } catch (error) {
        if (!account.current()) return;
        await account
          .post("/driver/status", { isOnline: false })
          .catch(() => {});
        throw error;
      }
    }
    if (account.current()) await refresh();
  });
}
async function setDistrict(districtId: string) {
  await act(async () => {
    await driverApi.post("/driver/district", { districtId });
    await refresh();
  });
}
async function synchronizeNative() {
  if (!nativeAndroid) return;
  const generation = sessionGeneration;
  const native = await nativeShift.status();
  if (generation !== sessionGeneration) return;
  if (native.running && native.userId !== driverSession.state.user?.id) {
    await stopNativeShift();
    return;
  }
  state.nativeRunning = native.running;
  state.nativeConnected =
    native.phase === "online" && Date.now() - native.lastReportAt < 30000;
  if (native.running) {
    state.gpsReady =
      native.phase === "online" &&
      Date.now() - native.lastReportAt < GPS_MAX_AGE_MS;
    if (state.gpsReady) {
      lastFixAt = lastLocationSent = native.lastReportAt;
      state.position = {
        lat: native.lat,
        lng: native.lng,
        accuracy: native.accuracy,
      };
      state.gpsError = "";
    } else
      state.gpsError = native.detail || "Ожидаем GPS и связь с диспетчером…";
  } else if (native.detail) {
    state.gpsReady = false;
    hideAvailableOrders();
    state.gpsError = native.detail;
    if (state.profile) state.profile.isOnline = false;
  }
}
async function enableNativeGps() {
  const generation = sessionGeneration;
  const account = nativeAccountRequest();
  state.gpsPending = true;
  try {
    const permissions = await nativeShift.permissions();
    if (!account.current()) return;
    if (!permissions.locationGranted)
      throw new Error("Разрешите точный GPS в настройках приложения.");
    const position = await nativeShift.location();
    if (!account.current()) return;
    const { data } = await account.post<{ districtId: string | null }>(
      "/driver/location",
      position,
    );
    if (generation !== sessionGeneration) return;
    state.position = position;
    lastLocationSent = Date.now();
    lastFixAt = position.timestamp;
    state.gpsReady = true;
    state.gpsError = "";
    if (state.profile) state.profile.districtId = data.districtId;
  } catch (error) {
    if (generation === sessionGeneration) await loseGps(errorMessage(error));
  } finally {
    if (generation === sessionGeneration) state.gpsPending = false;
  }
}
function enableGps() {
  if (nativeAndroid) {
    void enableNativeGps();
    return;
  }
  if (!navigator.geolocation) {
    void loseGps("Браузер не поддерживает геолокацию.");
    return;
  }
  state.gpsPending = true;
  const generation = sessionGeneration;
  const options = {
    enableHighAccuracy: true,
    maximumAge: 10000,
    timeout: 20000,
  };
  const report = async (position: GeolocationPosition) => {
    if (generation !== sessionGeneration) return;
    const {
      latitude: lat,
      longitude: lng,
      accuracy,
      heading,
      speed,
    } = position.coords;
    const age = Date.now() - position.timestamp;
    if (!Number.isFinite(age) || age < -5000 || age > GPS_MAX_AGE_MS) {
      void loseGps("GPS устарел. Ожидаем новые координаты.");
      return;
    }
    if (locationSending || Date.now() - lastLocationSent < 10000) return;
    locationSending = true;
    const epoch = gpsEpoch;
    try {
      const { data } = await driverApi.post<{ districtId: string | null }>(
        "/driver/location",
        {
          lat,
          lng,
          accuracy,
          ...(heading !== null ? { heading } : {}),
          ...(speed !== null && speed >= 0 ? { speed } : {}),
        },
      );
      if (generation !== sessionGeneration) return;
      if (epoch !== gpsEpoch) return;
      state.position = { lat, lng, accuracy };
      lastFixAt = position.timestamp;
      lastLocationSent = Date.now();
      state.gpsPending = false;
      const firstFix = !state.gpsReady;
      state.gpsReady = true;
      if (firstFix && state.profile?.isOnline) void recoverPrivateOffer();
      state.gpsError = "";
      if (state.profile) state.profile.districtId = data.districtId;
    } catch (error) {
      if (generation !== sessionGeneration) return;
      state.gpsPending = false;
      void loseGps("Координаты не отправлены. " + errorMessage(error));
    } finally {
      if (generation === sessionGeneration) locationSending = false;
    }
  };
  const failed = (error: GeolocationPositionError) => {
    if (generation !== sessionGeneration) return;
    state.gpsPending = false;
    void loseGps(
      error.code === error.PERMISSION_DENIED
        ? "Нет доступа к GPS. Разрешите геолокацию в браузере."
        : error.code === error.TIMEOUT
          ? "GPS не ответил вовремя. Нажмите GPS, чтобы повторить."
          : "GPS временно недоступен. Нажмите GPS, чтобы повторить.",
    );
    if (error.code === error.PERMISSION_DENIED) {
      if (gpsWatch !== undefined) navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = undefined;
      if (gpsTimer !== undefined) clearInterval(gpsTimer);
      gpsTimer = undefined;
    }
  };
  if (gpsWatch === undefined)
    gpsWatch = navigator.geolocation.watchPosition(report, failed, options);
  // Permission and an existing watch do not prove a fresh fix was accepted by the server.
  navigator.geolocation.getCurrentPosition(report, failed, {
    ...options,
    maximumAge: 0,
  });
  if (gpsTimer !== undefined) return;
  // A stationary driver may get no watch updates. Request a new fix rather
  // than reporting an old coordinate as fresh to keep availability alive.
  gpsTimer = setInterval(() => {
    if (generation !== sessionGeneration) return;
    if (
      Date.now() - lastLocationSent > GPS_MAX_AGE_MS ||
      Date.now() - lastFixAt > GPS_MAX_AGE_MS
    )
      void loseGps("GPS устарел. Ожидаем новые координаты.");
    navigator.geolocation.getCurrentPosition(report, failed, options);
  }, 20000);
}
function start() {
  if (nativeAndroid) {
    const timer = setInterval(() => {
      if (!document.hidden) void synchronizeNative();
    }, 2000);
    cleanups.push(() => clearInterval(timer));
  }
  const on = (event: string, handler: (payload: unknown) => void) =>
    cleanups.push(driverSession.on(event, handler));
  on("connect", () => void refresh());
  on("balance:updated", () => void refresh());
  on("admin:message", () => notifyChat());
  on("driver:status", (payload) => {
    const status = payload as {
      driverId: string;
      isOnline: boolean;
      isAvailable: boolean;
    };
    if (status.driverId !== state.profile?.id) return;
    state.profile.isOnline = status.isOnline;
    state.profile.isAvailable = status.isAvailable;
    if (!status.isOnline) hideAvailableOrders();
    void refresh();
  });
  on("districts:stats", (payload) => {
    if (Array.isArray(payload) && hasCurrentGps() && state.profile?.isOnline) {
      districtSnapshotVersion++;
      state.districts = payload as District[];
    }
  });
  on("order:private-offer", (payload) => receivePrivateOffer(payload as Order));
  on("order:private-offer-ended", (payload) => {
    offerVersion++;
    const ended = payload as {
      orderId: string;
      privateOfferExpiresAt?: string;
    };
    if (
      state.incoming?.id === ended.orderId &&
      state.incoming.privateOfferExpiresAt === ended.privateOfferExpiresAt
    )
      dismissIncoming();
    void refresh();
  });
  on("order:new", (payload) => {
    const order = payload as Order;
    if (
      !hasCurrentGps() ||
      !state.profile?.isOnline ||
      state.active ||
      state.incoming
    )
      return;
    state.incoming = order;
    notifyOrder(order);
  });
  on("order:taken", (payload) => {
    if (state.incoming?.id === (payload as { orderId: string }).orderId)
      dismissIncoming();
    void refresh();
  });
  for (const event of [
    "order:accepted",
    "order:waiting",
    "order:started",
    "order:completed",
    "order:cancelled",
  ])
    on(event, () => void refresh());
  const visibility = () => {
    if (!document.hidden) {
      closeOrderAlerts();
      void refresh();
    }
  };
  document.addEventListener("visibilitychange", visibility);
  cleanups.push(() =>
    document.removeEventListener("visibilitychange", visibility),
  );
  void refresh();
}
export function useDriver() {
  onMounted(() => {
    if (users++ === 0) start();
  });
  onUnmounted(() => {
    if (--users === 0) {
      cleanups.forEach((fn) => fn());
      cleanups = [];
      // GPS belongs to the authenticated driver session, not the current screen.
      // Explicit logout above releases the watch.
    }
  });
  return {
    state,
    refresh,
    accept,
    transition,
    setOnline,
    setDistrict,
    enableGps,
    dismissIncoming,
    declinePrivateOffer,
    session: driverSession,
  };
}
