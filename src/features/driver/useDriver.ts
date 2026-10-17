import { onMounted, onUnmounted, reactive, readonly, watch } from "vue";
import { driverApi, errorMessage, apiBase, tokens } from "@/shared/api";
import { driverSession } from "@/features/auth/session";
import { closeOrderAlerts, notifyOrder } from "./alerts";
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
  gpsFixReady: false,
  locationSyncPending: false,
  locationSyncError: "",
  nativeRunning: false,
  nativeConnected: false,
  offerSeconds: 0,
  position: null as { lat: number; lng: number; accuracy: number } | null,
  locationUpdatedAt: 0,
  clock: Date.now(),
});
export const driverState = readonly(state);
let users = 0;
let refreshVersion = 0;
let districtSnapshotVersion = 0;
let sessionGeneration = 0;
let cleanups: Array<() => void> = [];
let gpsWatch: number | undefined;
let lastLocationSent = 0;
let locationSyncFailureAt = 0;
let locationSending = false;
let nativeGpsRequestPending = false;
let gpsTimer: ReturnType<typeof setInterval> | undefined;
let lastFixAt = 0;
let gpsRequestSequence = 0;
let latestGpsRequestResolved = 0;
let offlinePending = false;
let gpsEpoch = 0;
let handledNativeStop = -1;
let offerTimer: ReturnType<typeof setInterval> | undefined;
let offerVersion = 0;
// A close event can overtake creation while its delivery awaits room sync.
// Keep only a short session-local memory, longer than the public popup window.
const closedPublicOffers = new Map<string, number>();
function pruneClosedPublicOffers() {
  const now = performance.now();
  for (const [id, until] of closedPublicOffers)
    if (until <= now) closedPublicOffers.delete(id);
}
function rememberClosedPublicOffer(orderId: string) {
  pruneClosedPublicOffers();
  closedPublicOffers.set(orderId, performance.now() + 60_000);
}
const GPS_MAX_AGE_MS = 60000;
const LOCATION_SYNC_FAILURE_GRACE_MS = 60000;
export function canControlShift() {
  return !!state.profile && state.profile.canControlShift !== false;
}
const otherDeviceMessage =
  "Смена активна на другом устройстве. Завершите её там, чтобы выйти на линию здесь.";
function requireShiftControl() {
  if (canControlShift()) return true;
  state.error = state.profile
    ? otherDeviceMessage
    : "Дождитесь загрузки профиля, затем повторите.";
  return false;
}
function hasCurrentGps() {
  return (
    canControlShift() &&
    state.gpsReady &&
    navigator.onLine &&
    (nativeAndroid
      ? state.nativeConnected || !state.nativeRunning
      : driverSession.state.connected) &&
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
function stopGpsTracking() {
  if (gpsWatch !== undefined) navigator.geolocation.clearWatch(gpsWatch);
  gpsWatch = undefined;
  if (gpsTimer !== undefined) clearInterval(gpsTimer);
  gpsTimer = undefined;
  state.gpsPending = false;
  state.locationSyncPending = false;
}

async function forceOffline(message: string, preserveLocalGps = false) {
  stopGpsTracking();
  gpsEpoch++;
  state.gpsReady = false;
  if (!preserveLocalGps) state.gpsFixReady = false;
  state.gpsError = message;
  state.locationSyncError = "";
  locationSyncFailureAt = 0;
  lastLocationSent = 0;
  hideAvailableOrders();
  if (!canControlShift() || !state.profile?.isOnline || offlinePending) return;
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

async function loseGps(message: string) {
  stopGpsTracking();
  await forceOffline(message);
}

function markLocationSyncFailure(message: string) {
  state.gpsReady = false;
  state.locationSyncPending = false;
  state.locationSyncError = message;
  locationSyncFailureAt ||= Date.now();
  hideAvailableOrders();
  if (
    state.profile?.isOnline &&
    Date.now() - locationSyncFailureAt > LOCATION_SYNC_FAILURE_GRACE_MS
  )
    void forceOffline("Связь с диспетчером потеряна. Вы вышли с линии.", true);
}
function dismissIncoming() {
  offerVersion++;
  if (offerTimer !== undefined) clearInterval(offerTimer);
  offerTimer = undefined;
  state.offerSeconds = 0;
  // Empty queue reconciliation must not pause a user-initiated sound unlock.
  // Only an actual incoming order owns the order-alert playback.
  if (state.incoming) closeOrderAlerts();
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
function receivePublicOffer(order: Order) {
  pruneClosedPublicOffers();
  if (
    closedPublicOffers.has(order.id) ||
    !hasCurrentGps() ||
    !state.profile?.isOnline ||
    state.active ||
    state.incoming ||
    (order.districtId ?? order.district?.id) !== state.profile.districtId ||
    !order.publicRegionOnlyUntil
  )
    return;
  const remainingMs =
    order.publicOfferRemainingMs ??
    Date.parse(order.publicRegionOnlyUntil) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return;
  const until = performance.now() + Math.min(20_000, remainingMs);
  // A private-offer recovery started before this event must not replace it.
  offerVersion++;
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
  notifyOrder(order);
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
  if (!requireShiftControl()) return;
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
    closedPublicOffers.clear();
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
    state.locationUpdatedAt = 0;
    state.gpsReady = false;
    state.gpsFixReady = false;
    state.locationSyncPending = false;
    state.locationSyncError = "";
    state.nativeRunning = false;
    state.nativeConnected = false;
    handledNativeStop = -1;
    lastFixAt = 0;
    locationSending = false;
    nativeGpsRequestPending = false;
    offlinePending = false;
    stopGpsTracking();
    lastLocationSent = 0;
    locationSyncFailureAt = 0;
    state.gpsError = "";
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
    const previouslyControlled = canControlShift();
    state.profile = profile.data;
    if (!canControlShift()) {
      if (previouslyControlled) gpsEpoch++;
      stopGpsTracking();
      state.gpsReady = false;
      state.gpsError = "";
      dismissIncoming();
    }
    state.balance = balance.data;
    if (districtVersion === districtSnapshotVersion)
      state.districts = districts.data;
    state.active = active.data;
    if (state.active) dismissIncoming();
    if (nativeAndroid && canControlShift()) await synchronizeNative();
    if (!current()) return;
    if (!state.gpsReady) {
      hideAvailableOrders();
      if (
        canControlShift() &&
        state.profile.isOnline &&
        !state.gpsFixReady &&
        !state.nativeRunning &&
        !state.gpsPending
      )
        enableGps();
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
  if (!requireShiftControl()) return;
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
  if (!state.active || !requireShiftControl()) return;
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
async function waitForSocket(timeoutMs = 3000) {
  if (driverSession.state.connected) return true;
  const deadline = Date.now() + timeoutMs;
  while (!driverSession.state.connected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return driverSession.state.connected;
}

async function acknowledgeCurrentLocation(generation: number) {
  if (
    generation !== sessionGeneration ||
    !canControlShift() ||
    !state.profile?.isOnline
  )
    return false;
  if (!state.position || !state.gpsFixReady) return false;
  if (Date.now() - lastFixAt > GPS_MAX_AGE_MS) return false;
  try {
    state.locationSyncPending = true;
    const { data } = await driverApi.post<{ districtId: string | null }>(
      "/driver/location",
      { ...state.position, capturedAt: state.locationUpdatedAt },
    );
    if (generation !== sessionGeneration) return false;
    lastLocationSent = Date.now();
    locationSyncFailureAt = 0;
    state.gpsReady = true;
    state.locationSyncError = "";
    if (state.profile) state.profile.districtId = data.districtId;
    return true;
  } catch (error) {
    if (generation === sessionGeneration)
      markLocationSyncFailure(errorMessage(error));
    return false;
  } finally {
    if (generation === sessionGeneration) state.locationSyncPending = false;
  }
}

async function setOnline() {
  if (!state.profile || !requireShiftControl()) return;
  const isOnline = !state.profile.isOnline;
  if (isOnline) {
    if (!state.gpsFixReady || Date.now() - lastFixAt > GPS_MAX_AGE_MS) {
      state.gpsError = "Включите GPS перед выходом на линию.";
      return;
    }
    const generation = sessionGeneration;
    await act(async () => {
      if (nativeAndroid) await checkNativeLocationPermission();
      if (
        !state.gpsFixReady ||
        !state.position ||
        Date.now() - lastFixAt > GPS_MAX_AGE_MS ||
        !navigator.onLine ||
        !(await waitForSocket())
      ) {
        if (generation !== sessionGeneration) return;
        state.error = "Не удалось подтвердить GPS и связь с диспетчером.";
        return;
      }
      const account = nativeAccountRequest();
      if (!account.current()) return;
      const { data } = await (nativeAndroid ? account : driverApi).post<{
        districtId: string | null;
      }>("/driver/status", {
        isOnline: true,
        isAvailable: true,
        position: { ...state.position, capturedAt: state.locationUpdatedAt },
      });
      if (!account.current()) return;
      lastLocationSent = Date.now();
      locationSyncFailureAt = 0;
      state.gpsReady = true;
      state.locationSyncError = "";
      if (state.profile) {
        state.profile.isOnline = true;
        state.profile.canControlShift = true;
        state.profile.districtId = data.districtId;
      }
      if (nativeAndroid) {
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
      if (account.current()) {
        if (!nativeAndroid && state.profile) {
          state.profile.isOnline = true;
          enableGps();
        }
        await refresh();
      }
    });
    return;
  }
  const account = nativeAccountRequest();
  await act(async () => {
    await stopNativeShift();
    gpsEpoch++;
    stopGpsTracking();
    state.gpsReady = false;
    state.locationSyncError = "";
    if (!account.current()) return;
    await (nativeAndroid ? account : driverApi).post("/driver/status", {
      isOnline: false,
      isAvailable: false,
    });
    if (!account.current()) return;
    if (account.current()) await refresh();
  });
}
async function checkNativeLocationPermission() {
  if (!nativeAndroid) return;
  const generation = sessionGeneration;
  const permission = await nativeShift.permissions();
  if (generation !== sessionGeneration) return;
  if (!permission.locationGranted) {
    await loseGps("Разрешите точный GPS в настройках приложения.");
  } else if (permission.locationEnabled !== true) {
    await loseGps("Включите GPS в настройках телефона.");
  }
}
async function synchronizeNative() {
  if (!nativeAndroid || !canControlShift()) return;
  const generation = sessionGeneration;
  const native = await nativeShift.status();
  if (generation !== sessionGeneration) return;
  if (native.running && native.userId !== driverSession.state.user?.id) {
    await stopNativeShift();
    return;
  }
  state.nativeRunning = native.running;
  const now = Date.now();
  const nativeFixAt = native.lastFixAt ?? native.lastReportAt;
  const localPermission =
    native.locationGranted !== false && native.locationEnabled !== false;
  if (
    localPermission &&
    Number.isFinite(nativeFixAt) &&
    now - nativeFixAt >= -5000 &&
    now - nativeFixAt < GPS_MAX_AGE_MS &&
    nativeFixAt >= lastFixAt &&
    Number.isFinite(native.lat) &&
    Number.isFinite(native.lng)
  ) {
    lastFixAt = nativeFixAt;
    state.position = {
      lat: native.lat,
      lng: native.lng,
      accuracy: native.accuracy,
    };
    state.locationUpdatedAt = nativeFixAt;
  }
  state.gpsFixReady =
    localPermission && lastFixAt > 0 && now - lastFixAt < GPS_MAX_AGE_MS;
  state.nativeConnected =
    native.running &&
    native.phase === "online" &&
    now - native.lastReportAt < 30000;
  state.gpsReady =
    native.running &&
    native.phase === "online" &&
    now - native.lastReportAt < GPS_MAX_AGE_MS &&
    state.gpsFixReady;
  if (state.gpsReady) {
    lastLocationSent = native.lastReportAt;
    state.gpsError = "";
    state.locationSyncError = "";
  } else if (native.running) {
    state.locationSyncError =
      native.detail || "Ожидаем GPS и связь с диспетчером…";
    if (!state.gpsFixReady)
      state.gpsError = native.detail || "Ожидаем свежий GPS…";
  } else if (native.detail && native.stopSequence !== handledNativeStop) {
    // The service can stop after a network failure while its last hardware fix
    // remains fresh. End availability without changing that local fix's age.
    handledNativeStop = native.stopSequence;
    hideAvailableOrders();
    state.locationSyncError = "";
    state.gpsError = state.gpsFixReady ? "" : native.detail;
    if (state.profile) state.profile.isOnline = false;
  }
}
async function enableNativeGps() {
  if (nativeGpsRequestPending) return;
  nativeGpsRequestPending = true;
  const generation = sessionGeneration;
  const account = nativeAccountRequest();
  state.gpsPending =
    !state.gpsFixReady || Date.now() - lastFixAt >= GPS_MAX_AGE_MS;
  try {
    const permissions = await nativeShift.permissions();
    if (!account.current()) return;
    if (!permissions.running && Number.isFinite(permissions.stopSequence))
      handledNativeStop = permissions.stopSequence;
    if (!permissions.locationGranted)
      throw new Error("Разрешите точный GPS в настройках приложения.");
    if (permissions.locationEnabled !== true)
      throw new Error("Включите GPS в настройках телефона.");
    const position = await nativeShift.location();
    if (!account.current()) return;
    state.position = position;
    state.locationUpdatedAt = position.timestamp;
    lastFixAt = position.timestamp;
    state.gpsFixReady = true;
    state.gpsPending = false;
    state.gpsError = "";
    if (!navigator.onLine || !state.profile?.isOnline || !canControlShift()) {
      state.gpsReady = false;
      return;
    }
    state.locationSyncPending = true;
    const { data } = await account.post<{ districtId: string | null }>(
      "/driver/location",
      { ...position, capturedAt: position.timestamp },
    );
    if (generation !== sessionGeneration) return;
    lastLocationSent = Date.now();
    locationSyncFailureAt = 0;
    state.locationSyncPending = false;
    state.gpsReady = true;
    state.gpsError = "";
    state.locationSyncError = "";
    if (state.profile) state.profile.districtId = data.districtId;
  } catch (error) {
    if (generation === sessionGeneration) {
      state.gpsPending = false;
      if (state.gpsFixReady) markLocationSyncFailure(errorMessage(error));
      else await loseGps(errorMessage(error));
    }
  } finally {
    if (generation === sessionGeneration) {
      state.gpsPending = false;
      nativeGpsRequestPending = false;
    }
  }
}
function enableGps() {
  if (!state.profile) return;
  if (nativeAndroid) {
    void enableNativeGps();
    return;
  }
  if (!navigator.geolocation) {
    void loseGps("Браузер не поддерживает геолокацию.");
    return;
  }
  // A refresh does not erase a usable local fix while the provider obtains
  // another sample. Only the first/stale fix needs a loading state.
  state.gpsPending =
    !state.gpsFixReady || Date.now() - lastFixAt >= GPS_MAX_AGE_MS;
  const generation = sessionGeneration;
  const trackingEpoch = gpsEpoch;
  const options = {
    enableHighAccuracy: true,
    maximumAge: 10000,
    timeout: 20000,
  };
  const report = async (position: GeolocationPosition, requestId = 0) => {
    if (generation !== sessionGeneration || trackingEpoch !== gpsEpoch) return;
    if (requestId && requestId < latestGpsRequestResolved) return;
    latestGpsRequestResolved = requestId || ++gpsRequestSequence;
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
    state.position = { lat, lng, accuracy };
    state.locationUpdatedAt = position.timestamp;
    lastFixAt = position.timestamp;
    state.gpsFixReady = true;
    state.gpsPending = false;
    state.gpsError = "";
    if (!navigator.onLine || !state.profile?.isOnline || !canControlShift())
      return;
    if (locationSending || Date.now() - lastLocationSent < 10000) return;
    locationSending = true;
    state.locationSyncPending = true;
    const epoch = gpsEpoch;
    try {
      const { data } = await driverApi.post<{ districtId: string | null }>(
        "/driver/location",
        {
          lat,
          lng,
          accuracy,
          capturedAt: position.timestamp,
          ...(heading !== null ? { heading } : {}),
          ...(speed !== null && speed >= 0 ? { speed } : {}),
        },
      );
      if (generation !== sessionGeneration) return;
      if (epoch !== gpsEpoch) return;
      lastLocationSent = Date.now();
      locationSyncFailureAt = 0;
      state.locationSyncPending = false;
      const firstFix = !state.gpsReady;
      state.gpsReady = true;
      if (firstFix && state.profile?.isOnline) void refresh();
      state.gpsError = "";
      state.locationSyncError = "";
      if (state.profile) state.profile.districtId = data.districtId;
    } catch (error) {
      if (generation !== sessionGeneration) return;
      markLocationSyncFailure(
        "Координаты не отправлены. " + errorMessage(error),
      );
    } finally {
      if (generation === sessionGeneration) {
        state.locationSyncPending = false;
        locationSending = false;
        if (!state.profile?.isOnline) stopGpsTracking();
      }
    }
  };
  const failed = (error: GeolocationPositionError, requestId = 0) => {
    if (generation !== sessionGeneration || trackingEpoch !== gpsEpoch) return;
    if (requestId && requestId < latestGpsRequestResolved) return;
    state.gpsPending = false;
    if (error.code === error.POSITION_UNAVAILABLE) {
      // A failed refresh does not invalidate a still-fresh accepted fix.
      // The existing age limit continues running; no timestamp is renewed.
      if (
        state.gpsFixReady &&
        Date.now() - lastFixAt < GPS_MAX_AGE_MS &&
        (!state.profile?.isOnline ||
          Date.now() - lastLocationSent < GPS_MAX_AGE_MS)
      )
        return;
      markLocationSyncFailure("GPS временно недоступен. Ожидаем новый сигнал.");
    } else {
      void loseGps(
        error.code === error.PERMISSION_DENIED
          ? "Нет доступа к GPS. Разрешите геолокацию в браузере."
          : "GPS не ответил вовремя. Нажмите GPS, чтобы повторить.",
      );
    }
    if (error.code === error.PERMISSION_DENIED) {
      if (gpsWatch !== undefined) navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = undefined;
      if (gpsTimer !== undefined) clearInterval(gpsTimer);
      gpsTimer = undefined;
    }
  };
  if (state.profile?.isOnline && canControlShift() && gpsWatch === undefined)
    gpsWatch = navigator.geolocation.watchPosition(report, failed, options);
  // Permission and an existing watch do not prove a fresh fix was accepted by the server.
  const initialRequest = ++gpsRequestSequence;
  navigator.geolocation.getCurrentPosition(
    (position) => void report(position, initialRequest),
    (error) => failed(error, initialRequest),
    { ...options, maximumAge: 0 },
  );
  if (!state.profile?.isOnline || !canControlShift() || gpsTimer !== undefined)
    return;
  // A stationary driver may get no watch updates. Request a new fix rather
  // than reporting an old coordinate as fresh to keep availability alive.
  gpsTimer = setInterval(() => {
    if (generation !== sessionGeneration) return;
    if (Date.now() - lastFixAt > GPS_MAX_AGE_MS)
      void loseGps("GPS устарел. Ожидаем новые координаты.");
    else if (
      state.profile?.isOnline &&
      Date.now() - lastLocationSent > GPS_MAX_AGE_MS
    )
      markLocationSyncFailure("Ожидаем подтверждение связи с диспетчером…");
    const request = ++gpsRequestSequence;
    navigator.geolocation.getCurrentPosition(
      (position) => void report(position, request),
      (error) => failed(error, request),
      options,
    );
  }, 10000);
}
function start() {
  const readinessClock = setInterval(() => {
    state.clock = Date.now();
    pruneClosedPublicOffers();
    if (
      !nativeAndroid &&
      canControlShift() &&
      state.profile?.isOnline &&
      locationSyncFailureAt &&
      state.clock - locationSyncFailureAt >= LOCATION_SYNC_FAILURE_GRACE_MS
    )
      void forceOffline(
        "Связь с диспетчером потеряна. Вы вышли с линии.",
        true,
      );
  }, 1000);
  cleanups.push(() => clearInterval(readinessClock));
  if (nativeAndroid) {
    const timer = setInterval(() => {
      if (!document.hidden) void synchronizeNative();
    }, 2000);
    cleanups.push(() => clearInterval(timer));
  }
  const on = (event: string, handler: (payload: unknown) => void) =>
    cleanups.push(driverSession.on(event, handler));
  on("connect", async () => {
    if (canControlShift() && state.profile?.isOnline && !nativeAndroid) {
      await acknowledgeCurrentLocation(sessionGeneration);
      enableGps();
    }
    await refresh();
  });
  on("disconnect", () => {
    if (!canControlShift() || !state.profile?.isOnline) return;
    lastLocationSent = 0;
    markLocationSyncFailure("GPS работает. Переподключаемся к диспетчеру…");
  });
  on("balance:updated", () => void refresh());
  on("driver:status", (payload) => {
    const status = payload as {
      driverId: string;
      isOnline: boolean;
      isAvailable: boolean;
    };
    if (status.driverId !== state.profile?.id) return;
    const wasOnline = state.profile.isOnline;
    state.profile.isOnline = status.isOnline;
    state.profile.isAvailable = status.isAvailable;
    if (!status.isOnline && wasOnline) {
      gpsEpoch++;
      stopGpsTracking();
      hideAvailableOrders();
    }
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
  on("order:new", (payload) => receivePublicOffer(payload as Order));
  on("order:taken", (payload) => {
    const { orderId } = payload as { orderId: string };
    rememberClosedPublicOffer(orderId);
    if (state.incoming?.id === orderId) dismissIncoming();
    void refresh();
  });
  for (const event of [
    "order:accepted",
    "order:waiting",
    "order:started",
    "order:completed",
    "order:cancelled",
  ])
    on(event, (payload) => {
      const order = payload as { id: string };
      if (event === "order:cancelled") rememberClosedPublicOffer(order.id);
      if (event === "order:cancelled" && state.incoming?.id === order.id)
        dismissIncoming();
      void refresh();
    });
  const visibility = () => {
    if (!document.hidden) {
      // Native notifications may exist before the WebView recovers an offer.
      // Browser playback belongs to an incoming order, not a permission probe.
      if (nativeAndroid || state.incoming) closeOrderAlerts();
      if (nativeAndroid)
        void checkNativeLocationPermission().then(() => refresh());
      else void refresh();
    }
  };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("focus", visibility);
  cleanups.push(() => window.removeEventListener("focus", visibility));
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
    enableGps,
    dismissIncoming,
    declinePrivateOffer,
    session: driverSession,
  };
}
