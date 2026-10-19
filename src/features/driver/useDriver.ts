import { onMounted, onUnmounted, reactive, readonly, ref, watch } from "vue";
import { driverApi, errorMessage, apiBase, tokens } from "@/shared/api";
import { driverSession } from "@/features/auth/session";
import { closeOrderAlerts, notifyOrder, reconcileOrderAlerts } from "./alerts";
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
  addressLookupRequest: 0,
  notice: "",
  noticeEventId: "",
  gpsError: "",
  gpsBlocked: false,
  gpsPending: false,
  gpsReady: false,
  gpsFixReady: false,
  locationSyncPending: false,
  locationSyncError: "",
  nativeRunning: false,
  nativeConnected: false,
  nativeLeaseExpiresAt: 0,
  offerSeconds: 0,
  position: null as { lat: number; lng: number; accuracy: number } | null,
  locationUpdatedAt: 0,
  clock: Date.now(),
});
export const driverState = readonly(state);
/** The unsent dispatcher-chat draft. It survives tab switches within one
 * driver session and is cleared with the session, never shared. */
export const chatDraft = ref("");
/** Android Back is not applied to an offer during its first second on screen.
 * A press that lands then, typically the second press of a minimize, was aimed
 * at the screen beneath. The shell answers it as a root press instead. */
export const OFFER_BACK_GUARD_MS = 1000;
const consumedNotices = new Set<string>();
export function consumeDriverNotice(eventId: string) {
  if (!eventId || consumedNotices.has(eventId)) return false;
  consumedNotices.add(eventId);
  if (consumedNotices.size > 100)
    consumedNotices.delete(consumedNotices.values().next().value as string);
  return true;
}
let users = 0;
let localGpsUsers = 0;
let refreshVersion = 0;
let districtSnapshotVersion = 0;
let sessionGeneration = 0;
let cleanups: Array<() => void> = [];
let lastLocationSent = 0;
let locationSyncFailureAt = 0;
let gpsAcquisitionPending = false;
let gpsWatch: number | undefined;
let locationSending = false;
let gpsAttempt: Promise<void> | undefined;
let nativeLocationRequest: string | undefined;
let gpsSuppressed = false;
let nextGpsAttemptAt = 0;
let gpsRetryDelay = 10000;
let fixReceivedAt = 0;
let fixAgeAtReceipt = 0;
function currentFixAge() {
  return lastFixAt
    ? fixAgeAtReceipt + performance.now() - fixReceivedAt
    : Infinity;
}
function recordFix(timestamp: number, age: number) {
  lastFixAt = timestamp;
  fixAgeAtReceipt = Math.max(0, age);
  fixReceivedAt = performance.now();
}
let lastFixAt = 0;
let offlinePending = false;
let gpsEpoch = 0;
let handledNativeStop = -1;
let offerTimer: ReturnType<typeof setInterval> | undefined;
let offerVersion = 0;
// A close event can overtake creation while its delivery awaits room sync.
// Keep only a short session-local memory, longer than the public popup window.
const closedPublicOffers = new Map<string, number>();
// order:cancelled can overtake a successful accept response. Remember the
// latest cancellation per order so that response cannot restore the trip.
const orderCancellations = new Map<string, number>();
let cancellationSequence = 0;
function recordCancellation(payload: unknown) {
  const orderId = (payload as { id?: unknown } | null)?.id;
  if (typeof orderId !== "string") return;
  orderCancellations.delete(orderId);
  orderCancellations.set(orderId, ++cancellationSequence);
  if (orderCancellations.size > 100)
    orderCancellations.delete(orderCancellations.keys().next().value as string);
}
function persistClosedOffers() {
  try {
    sessionStorage.setItem(
      `tayyn.closed-offers.${driverSession.state.user?.id}`,
      JSON.stringify([...closedPublicOffers]),
    );
  } catch {
    /* Memory still deduplicates when storage is unavailable. */
  }
}
function restoreClosedOffers() {
  try {
    const saved: unknown = JSON.parse(
      sessionStorage.getItem(
        `tayyn.closed-offers.${driverSession.state.user?.id}`,
      ) ?? "[]",
    );
    if (Array.isArray(saved))
      for (const entry of saved) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "number" &&
          entry[1] > Date.now() &&
          entry[1] <= Date.now() + 60_000
        )
          closedPublicOffers.set(entry[0], entry[1]);
      }
  } catch {
    /* A malformed or unavailable cache does not block orders. */
  }
}
restoreClosedOffers();
function pruneClosedPublicOffers() {
  const now = Date.now();
  for (const [id, until] of closedPublicOffers)
    if (until <= now) closedPublicOffers.delete(id);
}
function rememberClosedPublicOffer(eventId: string) {
  pruneClosedPublicOffers();
  closedPublicOffers.set(eventId, Date.now() + 60_000);
  persistClosedOffers();
}
const GPS_MAX_AGE_MS = 60000;
const LOCATION_SYNC_FAILURE_GRACE_MS = 60000;
export function canControlShift() {
  return !!state.profile && state.profile.canControlShift !== false;
}
export function connectionRecovering() {
  if (!canControlShift() || !state.profile?.isOnline) return false;
  return nativeAndroid
    ? state.nativeRunning && state.clock < state.nativeLeaseExpiresAt
    : locationSyncFailureAt > 0 &&
        state.clock < locationSyncFailureAt + LOCATION_SYNC_FAILURE_GRACE_MS;
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
    currentFixAge() < GPS_MAX_AGE_MS
  );
}
function hideAvailableOrders() {
  dismissIncoming();
  state.districts = state.districts.map((d) => ({
    ...d,
    activeOrders: 0,
    publicAvailableOrders: 0,
    onlineDrivers: 0,
    freeDrivers: 0,
  }));
}
function stopGpsTracking() {
  if (gpsWatch !== undefined) navigator.geolocation.clearWatch(gpsWatch);
  gpsWatch = undefined;
  locationSending = false;
  state.gpsPending = false;
  state.locationSyncPending = false;
  gpsEpoch++;
  gpsAcquisitionPending = false;
  gpsAttempt = undefined;
  if (nativeAndroid && nativeLocationRequest) {
    void nativeShift
      .cancelLocation({ requestKey: nativeLocationRequest })
      .catch(() => {});
    nativeLocationRequest = undefined;
  }
}

async function forceOffline(message: string, preserveLocalGps = false) {
  stopGpsTracking();
  gpsEpoch++;
  state.gpsReady = false;
  if (!preserveLocalGps) {
    state.gpsFixReady = false;
  }
  state.gpsError = message;
  state.locationSyncError = "";
  locationSyncFailureAt = 0;
  lastLocationSent = 0;
  hideAvailableOrders();
  if (!canControlShift() || !state.profile?.isOnline || offlinePending) return;
  // A refresh started before this local decision read the old shift state.
  refreshVersion++;
  state.loading = false;
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
function dismissIncoming(eventId = state.incoming?.notificationEventId) {
  if (
    !state.incoming ||
    !eventId ||
    state.incoming.notificationEventId !== eventId
  )
    return;
  rememberClosedPublicOffer(eventId);
  offerVersion++;
  if (offerTimer !== undefined) clearInterval(offerTimer);
  offerTimer = undefined;
  state.offerSeconds = 0;
  // Empty queue reconciliation must not pause a user-initiated sound unlock.
  // Only an actual incoming order owns the order-alert playback.
  if (state.incoming) closeOrderAlerts([eventId]);
  state.incoming = null;
}

function receivePrivateOffer(order: Order, sound = true) {
  if (
    state.incoming?.id === order.id &&
    state.incoming.notificationEventId !== order.notificationEventId
  ) {
    const currentDeadline =
      state.incoming.privateOfferExpiresAt ??
      state.incoming.publicRegionOnlyUntil;
    const candidateDeadline =
      order.privateOfferExpiresAt ?? order.publicRegionOnlyUntil;
    if (
      currentDeadline &&
      candidateDeadline &&
      Date.parse(candidateDeadline) <= Date.parse(currentDeadline)
    )
      return;
  }

  if (
    !order.notificationEventId ||
    closedPublicOffers.has(order.notificationEventId) ||
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
  if (state.incoming?.notificationEventId === order.notificationEventId) return;
  dismissIncoming();
  offerVersion++;
  state.incoming = order;
  const tick = () => {
    state.offerSeconds = Math.max(
      0,
      Math.ceil((until - performance.now()) / 1000),
    );
    if (!state.offerSeconds) dismissIncoming(order.notificationEventId);
  };
  tick();
  offerTimer = setInterval(tick, 250);
  if (sound)
    notifyOrder(order, {
      eventId: order.notificationEventId,
      expiresAt: order.privateOfferExpiresAt,
      remainingMs,
    });
}
function receivePublicOffer(order: Order) {
  if (
    state.incoming?.id === order.id &&
    state.incoming.notificationEventId !== order.notificationEventId
  ) {
    const currentDeadline =
      state.incoming.privateOfferExpiresAt ??
      state.incoming.publicRegionOnlyUntil;
    const candidateDeadline =
      order.privateOfferExpiresAt ?? order.publicRegionOnlyUntil;
    if (
      currentDeadline &&
      candidateDeadline &&
      Date.parse(candidateDeadline) <= Date.parse(currentDeadline)
    )
      return;
  }

  pruneClosedPublicOffers();
  if (
    !order.notificationEventId ||
    closedPublicOffers.has(order.notificationEventId) ||
    !hasCurrentGps() ||
    !state.profile?.isOnline ||
    state.active ||
    (state.incoming && state.incoming.id !== order.id) ||
    (order.districtId ?? order.district?.id) !== state.profile.districtId ||
    !order.publicRegionOnlyUntil
  )
    return;
  const remainingMs =
    order.publicOfferRemainingMs ??
    Date.parse(order.publicRegionOnlyUntil) -
      (order.serverTime ? Date.parse(order.serverTime) : Date.now());
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return;
  if (state.incoming?.notificationEventId === order.notificationEventId) return;
  dismissIncoming();
  const until = performance.now() + Math.min(20_000, remainingMs);
  // A private-offer recovery started before this event must not replace it.
  offerVersion++;
  state.incoming = order;
  const tick = () => {
    state.offerSeconds = Math.max(
      0,
      Math.ceil((until - performance.now()) / 1000),
    );
    if (!state.offerSeconds) dismissIncoming(order.notificationEventId);
  };
  tick();
  offerTimer = setInterval(tick, 250);
  notifyOrder(order, {
    eventId: order.notificationEventId,
    expiresAt: order.publicRegionOnlyUntil,
    remainingMs,
  });
}
async function recoverOffers() {
  const version = ++offerVersion;
  const generation = sessionGeneration;
  try {
    const requestedAt = performance.now();
    const { data } = await driverApi.get<{
      events: Array<{
        id: string;
        channel: "orders";
        offerAttemptId: string;
        expiresAt: string;
        serverTime: string;
        order: Order;
      }>;
      serverTime: string;
    }>("/driver/notifications/inbox");
    if (
      generation !== sessionGeneration ||
      version !== offerVersion ||
      !driverSession.state.accessToken
    )
      return;
    const eventIds = data.events.map((event) => event.id);
    reconcileOrderAlerts(eventIds, data.serverTime);
    if (
      state.incoming &&
      !eventIds.includes(state.incoming.notificationEventId)
    )
      dismissIncoming();
    for (const event of data.events) {
      const remainingMs =
        Date.parse(event.expiresAt) -
        Date.parse(event.serverTime ?? data.serverTime) -
        (performance.now() - requestedAt);
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) continue;
      const order = {
        ...event.order,
        offerAttemptId: event.offerAttemptId,
        notificationEventId: event.id,
        serverTime: event.serverTime ?? data.serverTime,
      };
      if (order.privateOfferExpiresAt)
        receivePrivateOffer({ ...order, privateOfferRemainingMs: remainingMs });
      else
        receivePublicOffer({ ...order, publicOfferRemainingMs: remainingMs });
    }
  } catch (error) {
    if (generation === sessionGeneration && version === offerVersion)
      state.error = errorMessage(error);
  }
}
/** Driver-initiated close by X or Back. A pending accept or decline owns the
 * offer until it settles, so the close is refused and the dialog stays. */
function closeIncoming() {
  if (state.busy || !state.incoming) return;
  if (state.incoming.privateOfferExpiresAt) void declinePrivateOffer();
  else dismissIncoming();
}
async function declinePrivateOffer() {
  if (!requireShiftControl()) return;
  const orderId = state.incoming?.id;
  if (!orderId || !state.incoming?.privateOfferExpiresAt) return;
  const generation = sessionGeneration;
  const privateOfferExpiresAt = state.incoming.privateOfferExpiresAt;
  const eventId = state.incoming.notificationEventId;
  await act(async () => {
    await driverApi.post("/orders/private-offer/decline", {
      orderId,
      privateOfferExpiresAt,
    });
    if (generation !== sessionGeneration) return;
    if (state.incoming?.notificationEventId === eventId) dismissIncoming();
    await refresh();
  });
}

// Session cleanup outlives route components, including navigation to login.
watch(
  () => driverSession.state.user?.id,
  () => {
    sessionGeneration++;
    closedPublicOffers.clear();
    orderCancellations.clear();
    chatDraft.value = "";
    restoreClosedOffers();
    closeOrderAlerts();
    gpsEpoch++;
    refreshVersion++;
    dismissIncoming();
    state.profile = null;
    state.balance = null;
    state.active = null;
    state.districts = [];
    state.error = "";
    state.notice = "";
    state.noticeEventId = "";
    consumedNotices.clear();
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
    state.nativeLeaseExpiresAt = 0;
    handledNativeStop = -1;
    lastFixAt = 0;
    state.gpsBlocked = false;
    gpsAcquisitionPending = false;
    gpsSuppressed = false;
    nextGpsAttemptAt = 0;
    gpsRetryDelay = 10000;
    offlinePending = false;
    stopGpsTracking();
    lastLocationSent = 0;
    locationSyncFailureAt = 0;
    state.gpsError = "";
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
      await recoverOffers();
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
  state.noticeEventId = "";
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
  const cancellationBefore = orderCancellations.get(orderId);
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
    // A successful response can arrive after cancellation and reoffer. It owns
    // only its original alert; the current-order read resolves newer state.
    dismissIncoming(data.notificationEventId);
    if (
      orderCancellations.get(orderId) === cancellationBefore &&
      !state.incoming &&
      (!state.active ||
        (state.active.id === data.id &&
          state.active.offerAttemptId === data.offerAttemptId))
    )
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
  const attemptId = state.active.offerAttemptId;
  const generation = sessionGeneration;
  await act(async () => {
    await driverApi.post(`/orders/${action}`, {
      orderId,
      ...(reason ? { reason } : {}),
    });
    if (generation !== sessionGeneration) return;
    await refresh();
    if (generation !== sessionGeneration) return;
    state.noticeEventId = `${generation}:${orderId}:${attemptId}:${action}`;
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
  if (currentFixAge() > GPS_MAX_AGE_MS) return false;
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
    const generation = sessionGeneration;
    await act(async () => {
      gpsSuppressed = false;
      if (
        nativeAndroid ||
        !state.gpsFixReady ||
        currentFixAge() >= GPS_MAX_AGE_MS ||
        state.gpsBlocked
      )
        await enableGps(true);
      if (generation !== sessionGeneration) return;
      if (state.gpsBlocked || !state.gpsFixReady) {
        state.error =
          state.gpsError ||
          "Не удалось получить координаты. Повторите выход на линию.";
        return;
      }
      if (
        !state.gpsFixReady ||
        !state.position ||
        currentFixAge() > GPS_MAX_AGE_MS ||
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
        // Only a successful explicit Online action requests an optional label.
        // Reconnects/profile restores and recurring GPS never trigger lookup.
        state.addressLookupRequest++;
        await refresh();
      }
    });
    return;
  }
  const account = nativeAccountRequest();
  gpsSuppressed = true;
  stopGpsTracking();
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
  // Focus/reconnect only reads permission. It must not reopen an OS prompt.
  const permission = await nativeShift.status();
  if (generation !== sessionGeneration) return;
  state.gpsBlocked =
    !permission.locationGranted || permission.locationEnabled !== true;
  if (!permission.locationGranted) {
    await loseGps("Разрешите точный GPS в настройках приложения.");
  } else if (permission.locationEnabled !== true) {
    await loseGps("Включите GPS в настройках телефона.");
  }
}
async function synchronizeNative() {
  if (!nativeAndroid || !canControlShift()) return;
  const generation = sessionGeneration;
  const epoch = gpsEpoch;
  const native = await nativeShift.status();
  if (generation !== sessionGeneration || epoch !== gpsEpoch) return;
  if (native.running && native.userId !== driverSession.state.user?.id) {
    await stopNativeShift();
    return;
  }
  state.nativeRunning = native.running;
  // Project the native service's existing monotonic lease. This only controls
  // presentation; the native service remains responsible for expiry/recovery.
  state.nativeLeaseExpiresAt = native.running
    ? Date.now() + Math.max(0, native.leaseRemainingMs ?? 0)
    : 0;
  const now = Date.now();
  const nativeFixAt = native.lastFixAt ?? 0;
  const nativeFixAge = native.fixAgeMs ?? now - nativeFixAt;
  const localPermission =
    native.locationGranted !== false && native.locationEnabled !== false;
  if (
    native.userId === driverSession.state.user?.id &&
    localPermission &&
    Number.isFinite(nativeFixAt) &&
    nativeFixAge >= 0 &&
    nativeFixAge <= GPS_MAX_AGE_MS &&
    (!lastFixAt || nativeFixAge <= currentFixAge()) &&
    Number.isFinite(native.lat) &&
    Number.isFinite(native.lng) &&
    Math.abs(native.lat) <= 90 &&
    Math.abs(native.lng) <= 180 &&
    Number.isFinite(native.accuracy) &&
    native.accuracy >= 0 &&
    native.accuracy <= 100
  ) {
    recordFix(nativeFixAt, nativeFixAge);
    state.position = {
      lat: native.lat,
      lng: native.lng,
      accuracy: native.accuracy,
    };
    state.locationUpdatedAt = nativeFixAt;
  }
  state.gpsBlocked = !localPermission;
  state.gpsFixReady =
    localPermission && lastFixAt > 0 && currentFixAge() < GPS_MAX_AGE_MS;
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
interface LocalFix {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
  ageMs?: number;
}
function acceptLocalFix(position: LocalFix) {
  const age = position.ageMs ?? Date.now() - position.timestamp;
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age > GPS_MAX_AGE_MS ||
    !Number.isFinite(position.lat) ||
    Math.abs(position.lat) > 90 ||
    !Number.isFinite(position.lng) ||
    Math.abs(position.lng) > 180 ||
    !Number.isFinite(position.accuracy) ||
    position.accuracy < 0 ||
    position.accuracy > 100
  )
    throw new Error("Нет достаточно точного актуального местоположения.");
  if (lastFixAt && age > currentFixAge() + 250) return;
  state.position = position;
  state.locationUpdatedAt = position.timestamp;
  recordFix(position.timestamp, age);
  state.gpsFixReady = true;
  state.gpsBlocked = false;
  state.gpsError = "";
  state.gpsPending = false;
}
async function reportBrowserFix() {
  if (
    nativeAndroid ||
    locationSending ||
    !navigator.onLine ||
    !state.profile?.isOnline ||
    !canControlShift() ||
    Date.now() - lastLocationSent < 10000 ||
    !state.gpsFixReady
  )
    return;
  const epoch = gpsEpoch;
  const account = nativeAccountRequest();
  const current = () => account.current() && epoch === gpsEpoch;
  locationSending = true;
  state.locationSyncPending = true;
  let recovered = false;
  try {
    const { data } = await driverApi.post<{ districtId: string | null }>(
      "/driver/location",
      { ...state.position, capturedAt: state.locationUpdatedAt },
    );
    if (!current()) return;
    recovered = !state.gpsReady;
    lastLocationSent = Date.now();
    locationSyncFailureAt = 0;
    state.gpsReady = true;
    state.locationSyncError = "";
    if (state.profile) state.profile.districtId = data.districtId;
  } catch (error) {
    if (current()) markLocationSyncFailure(errorMessage(error));
  } finally {
    if (current()) {
      locationSending = false;
      state.locationSyncPending = false;
    }
  }
  // Readiness loss clears card counts. A same-region fix does not cause a
  // districts:stats broadcast, so reload the snapshot once reporting recovers.
  // The report is already settled; refresh applies its own session guards.
  if (recovered && current()) void refresh();
}
function fromBrowserFix(fix: GeolocationPosition): LocalFix {
  return {
    lat: fix.coords.latitude,
    lng: fix.coords.longitude,
    accuracy: fix.coords.accuracy,
    timestamp: fix.timestamp,
  };
}
/** One finite acquisition at a time. Scheduled retries never request permission. */
function enableGps(explicit = false): Promise<void> {
  if (gpsAttempt) return gpsAttempt;
  const pending = acquireGps(explicit).finally(() => {
    if (gpsAttempt === pending) gpsAttempt = undefined;
  });
  gpsAttempt = pending;
  return pending;
}
async function acquireGps(explicit: boolean): Promise<void> {
  if (!state.profile || !driverSession.state.accessToken) return;
  if (gpsAcquisitionPending) return;
  if (!explicit && (gpsSuppressed || performance.now() < nextGpsAttemptAt))
    return;
  gpsAcquisitionPending = true;
  const generation = sessionGeneration;
  const epoch = gpsEpoch;
  const current = () => generation === sessionGeneration && epoch === gpsEpoch;
  state.gpsPending = !state.gpsFixReady || currentFixAge() >= GPS_MAX_AGE_MS;
  try {
    let position: LocalFix;
    if (nativeAndroid) {
      const permission = await (explicit
        ? nativeShift.permissions({ enableLocation: true })
        : nativeShift.status());
      if (!current()) return;
      if (!permission.running && Number.isFinite(permission.stopSequence))
        handledNativeStop = permission.stopSequence;
      state.gpsBlocked =
        !permission.locationGranted || permission.locationEnabled !== true;
      if (!permission.locationGranted)
        throw new Error("Разрешите точное местоположение для выхода на линию.");
      if (permission.locationEnabled !== true)
        throw new Error(
          "Включите местоположение телефона для выхода на линию.",
        );
      const requestKey = crypto.randomUUID();
      nativeLocationRequest = requestKey;
      try {
        position = await nativeShift.location({ requestKey });
      } finally {
        if (nativeLocationRequest === requestKey)
          nativeLocationRequest = undefined;
      }
    } else {
      if (!navigator.geolocation) {
        state.gpsBlocked = true;
        throw new Error("Браузер не поддерживает геолокацию.");
      }
      if (state.gpsBlocked && navigator.permissions) {
        const permission = await navigator.permissions
          .query({ name: "geolocation" })
          .catch(() => null);
        if (!current()) return;
        if (permission) state.gpsBlocked = permission.state === "denied";
      }
      if (gpsWatch === undefined)
        gpsWatch = navigator.geolocation.watchPosition(
          (fix) => {
            if (!current()) return;
            try {
              acceptLocalFix(fromBrowserFix(fix));
              void reportBrowserFix();
            } catch {
              /* Await a usable sample. */
            }
          },
          (error) => {
            if (!current()) return;
            state.gpsBlocked = error.code === error.PERMISSION_DENIED;
            if (!state.gpsBlocked) return;
            state.gpsFixReady = false;
            state.gpsReady = false;
            if (state.profile?.isOnline)
              void forceOffline("Нет доступа к местоположению.");
            if (gpsWatch !== undefined)
              navigator.geolocation.clearWatch(gpsWatch);
            gpsWatch = undefined;
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 90000 },
        );
      position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (fix) => resolve(fromBrowserFix(fix)),
          (error) => {
            if (current())
              state.gpsBlocked = error.code === error.PERMISSION_DENIED;
            reject(
              new Error(
                error.code === error.PERMISSION_DENIED
                  ? "Разрешите геолокацию в браузере."
                  : "Местоположение временно недоступно. Повторите выход на линию.",
              ),
            );
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 90000 },
        );
      });
    }
    if (!current()) return;
    acceptLocalFix(position);
    gpsRetryDelay = 10000;
    nextGpsAttemptAt = performance.now() + 10000;
    await reportBrowserFix();
  } catch (error) {
    if (!current()) return;
    state.gpsError = errorMessage(error);
    if (state.gpsBlocked && gpsWatch !== undefined) {
      navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = undefined;
    }
    if (currentFixAge() >= GPS_MAX_AGE_MS || state.gpsBlocked) {
      state.gpsFixReady = false;
      state.gpsReady = false;
      hideAvailableOrders();
    }
    nextGpsAttemptAt = performance.now() + gpsRetryDelay;
    gpsRetryDelay = Math.min(30000, gpsRetryDelay * 2);
  } finally {
    if (current()) {
      gpsAcquisitionPending = false;
      state.gpsPending = false;
      state.locationSyncPending = false;
    }
  }
}
function acquireVisibleGps() {
  if (
    !state.profile ||
    gpsSuppressed ||
    gpsAcquisitionPending ||
    document.hidden ||
    (!localGpsUsers && !state.profile.isOnline) ||
    state.nativeRunning
  )
    return;
  void enableGps();
}

function start() {
  const offerRecovery = setInterval(() => {
    if (
      !document.hidden &&
      hasCurrentGps() &&
      state.profile?.isOnline &&
      !state.active
    )
      void recoverOffers();
  }, 5000);
  cleanups.push(() => clearInterval(offerRecovery));
  const readinessClock = setInterval(() => {
    state.clock = Date.now();
    pruneClosedPublicOffers();
    if (currentFixAge() >= GPS_MAX_AGE_MS) {
      state.gpsFixReady = false;
      state.gpsReady = false;
      if (
        !nativeAndroid &&
        lastFixAt &&
        state.profile?.isOnline &&
        canControlShift()
      )
        void forceOffline("Нет актуального местоположения.");
    }
    acquireVisibleGps();
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
  function invalidateOffer(payload: unknown) {
    offerVersion++;
    const ended = payload as { notificationEventId?: string; eventId?: string };
    const eventId = ended.notificationEventId ?? ended.eventId;
    if (eventId) {
      rememberClosedPublicOffer(eventId);
      closeOrderAlerts([eventId]);
      dismissIncoming(eventId);
    }
    void refresh();
  }
  on("order:private-offer-ended", invalidateOffer);
  on("order:new", (payload) => receivePublicOffer(payload as Order));
  on("notification:event", (payload) => {
    if (
      (payload as { event?: { channel?: string } }).event?.channel ===
        "orders" &&
      hasCurrentGps() &&
      !state.active
    )
      void recoverOffers();
  });
  on("order:taken", invalidateOffer);
  for (const event of [
    "order:accepted",
    "order:waiting",
    "order:started",
    "order:completed",
    "order:cancelled",
  ])
    on(event, (payload) => {
      if (event === "order:cancelled") {
        recordCancellation(payload);
        invalidateOffer(payload);
      }
      void refresh();
    });
  const visibility = () => {
    if (document.hidden) {
      if (!state.profile?.isOnline) stopGpsTracking();
    } else {
      nextGpsAttemptAt = 0;
      acquireVisibleGps();
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
export function useDriver(options: { localGps?: boolean } = {}) {
  onMounted(() => {
    if (options.localGps) {
      localGpsUsers++;
      acquireVisibleGps();
    }
    if (users++ === 0) start();
  });
  onUnmounted(() => {
    if (options.localGps && --localGpsUsers === 0 && !state.profile?.isOnline)
      stopGpsTracking();
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
    closeIncoming,
    declinePrivateOffer,
    session: driverSession,
  };
}
