import { onMounted, onUnmounted, reactive, readonly, watch } from "vue";
import { driverApi, errorMessage } from "@/shared/api";
import { driverSession } from "@/features/auth/session";
import { closeOrderAlerts, notifyOrder } from "./alerts";
import type { Balance, District, DriverProfile, Order } from "./model";

const state = reactive({
  profile: null as DriverProfile | null,
  balance: null as Balance | null,
  districts: [] as District[],
  active: null as Order | null,
  incoming: null as Order | null,
  loading: false,
  busy: false,
  error: "",
  notice: "",
  gpsError: "",
  gpsPending: false,
  gpsReady: false,
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
  closeOrderAlerts();
  state.incoming = null;
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
    state.position = null;
    state.gpsReady = false;
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
    if (!state.gpsReady) {
      hideAvailableOrders();
      if (state.profile.isOnline)
        void loseGps("Включите GPS перед выходом на линию.");
    }
  } catch (error) {
    if (current()) state.error = errorMessage(error);
  } finally {
    if (current()) state.loading = false;
  }
}
async function act(work: () => Promise<void>) {
  if (state.busy) return;
  state.busy = true;
  state.error = "";
  state.notice = "";
  try {
    await work();
  } catch (error) {
    state.error = errorMessage(error);
  } finally {
    state.busy = false;
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
  await act(async () => {
    dismissIncoming();
    const { data } = await driverApi.post<Order>("/orders/accept", {
      orderId,
      etaMinutes,
    });
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
async function setOnline() {
  if (!state.profile) return;
  const isOnline = !state.profile.isOnline;
  if (isOnline && !hasCurrentGps()) {
    state.gpsError = "Включите GPS перед выходом на линию.";
    return;
  }
  await act(async () => {
    await driverApi.post("/driver/status", { isOnline, isAvailable: isOnline });
    await refresh();
  });
}
async function setDistrict(districtId: string) {
  await act(async () => {
    await driverApi.post("/driver/district", { districtId });
    await refresh();
  });
}
function enableGps() {
  state.gpsError = "";
  if (!navigator.geolocation) {
    void loseGps("Браузер не поддерживает геолокацию.");
    return;
  }
  if (gpsWatch !== undefined) return;
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
    lastFixAt = position.timestamp;
    state.position = { lat, lng, accuracy };
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
      lastLocationSent = Date.now();
      state.gpsPending = false;
      state.gpsReady = true;
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
        : "GPS временно недоступен. Ожидаем координаты.",
    );
    if (error.code === error.PERMISSION_DENIED) {
      if (gpsWatch !== undefined) navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = undefined;
      if (gpsTimer !== undefined) clearInterval(gpsTimer);
      gpsTimer = undefined;
    }
  };
  gpsWatch = navigator.geolocation.watchPosition(report, failed, options);
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
  const on = (event: string, handler: (payload: unknown) => void) =>
    cleanups.push(driverSession.on(event, handler));
  on("connect", () => void refresh());
  on("balance:updated", () => void refresh());
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
    session: driverSession,
  };
}
