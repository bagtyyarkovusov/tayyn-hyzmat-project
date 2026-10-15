import { computed, onMounted, onUnmounted, reactive, watch } from "vue";
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
  deadline: 0,
  now: Date.now(),
  loading: false,
  busy: false,
  error: "",
  notice: "",
  gpsError: "",
  gpsPending: false,
  position: null as { lat: number; lng: number; accuracy: number } | null,
});
let users = 0;
let cleanups: Array<() => void> = [];
let clock: ReturnType<typeof setInterval> | undefined;
let autoAccept: ReturnType<typeof setTimeout> | undefined;
let gpsWatch: number | undefined;
let lastLocationSent = 0;
let locationSending = false;
function dismissIncoming() {
  closeOrderAlerts();
  if (autoAccept) clearTimeout(autoAccept);
  autoAccept = undefined;
  state.incoming = null;
  state.deadline = 0;
}

// Session cleanup outlives route components, including navigation to login.
watch(
  () => driverSession.state.accessToken,
  (token) => {
    if (token) return;
    dismissIncoming();
    state.profile = null;
    state.balance = null;
    state.active = null;
    state.districts = [];
    state.error = "";
    state.position = null;
    state.gpsError = "";
    state.gpsPending = false;
    if (gpsWatch !== undefined) navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = undefined;
  },
);
async function refresh() {
  state.loading = true;
  state.error = "";
  try {
    const [profile, balance, districts, active] = await Promise.all([
      driverApi.get<DriverProfile>("/driver/profile"),
      driverApi.get<Balance>("/driver/balance"),
      driverApi.get<District[]>("/districts"),
      driverApi.get<Order | null>("/orders/current"),
    ]);
    state.profile = profile.data;
    state.balance = balance.data;
    state.districts = districts.data;
    state.active = active.data;
    if (state.active) dismissIncoming();
  } catch (error) {
    state.error = errorMessage(error);
  } finally {
    state.loading = false;
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
    state.gpsError =
      "Браузер не поддерживает геолокацию. Выберите район вручную.";
    return;
  }
  if (gpsWatch !== undefined) return;
  state.gpsPending = true;
  gpsWatch = navigator.geolocation.watchPosition(
    async (position) => {
      state.gpsPending = false;
      state.gpsError = "";
      const {
        latitude: lat,
        longitude: lng,
        accuracy,
        heading,
        speed,
      } = position.coords;
      state.position = { lat, lng, accuracy };
      if (locationSending || Date.now() - lastLocationSent < 10000) return;
      locationSending = true;
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
        lastLocationSent = Date.now();
        if (state.profile) state.profile.districtId = data.districtId;
      } catch (error) {
        state.gpsError = "Координаты не отправлены. " + errorMessage(error);
      } finally {
        locationSending = false;
      }
    },
    () => {
      state.gpsPending = false;
      state.gpsError =
        "Нет доступа к GPS. Разрешите геолокацию в браузере или выберите район вручную.";
      if (gpsWatch !== undefined) navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = undefined;
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
  );
}
function start() {
  const on = (event: string, handler: (payload: unknown) => void) =>
    cleanups.push(driverSession.on(event, handler));
  on("connect", () => void refresh());
  on("balance:updated", () => void refresh());
  on("districts:stats", (payload) => {
    if (Array.isArray(payload)) state.districts = payload as District[];
  });
  on("order:new", (payload) => {
    const order = payload as Order;
    if (state.active || state.incoming) return;
    state.incoming = order;
    notifyOrder(order);
    state.deadline = Date.now() + 300000;
    autoAccept = setTimeout(() => void accept(order.id, 5), 300000);
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
  clock = setInterval(() => (state.now = Date.now()), 1000);
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
      if (clock) clearInterval(clock);
      if (gpsWatch !== undefined) navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = undefined;
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
    countdown: computed(() =>
      Math.max(0, Math.ceil((state.deadline - state.now) / 1000)),
    ),
    session: driverSession,
  };
}
