import { onMounted, onUnmounted, ref, watch } from "vue";
import { useDocumentVisibility, useOnline } from "@vueuse/core";

interface Position {
  lat: number;
  lng: number;
}
interface AddressReply {
  address: string | null;
  resolvedAt?: string;
  retryAt?: string;
  reason?: string;
  convenienceConsumed?: boolean;
  position: Position | null;
}
interface AddressApi {
  post<T>(path: string, body: unknown): Promise<{ data: T }>;
}
export interface AddressPolicy {
  online: () => boolean;
  connected: () => boolean;
  transitionPending: () => boolean;
  capturedAt: () => number;
  installation: () => string;
  onlineRequest: () => number;
}
type Purpose = "off-shift" | "online" | "refresh";
const interval = 300_000;
function distance(a: Position, b: Position) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) *
      Math.cos(b.lat * rad) *
      Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

/** Address demand is optional. Local GPS and shift availability never await it. */
export function useLocationAddress(
  position: () => Position | null,
  driverId: () => string | undefined,
  api: AddressApi,
  enabled: () => boolean,
  policy: AddressPolicy,
) {
  const address = ref("");
  const retryAt = ref(0);
  const clock = ref(Date.now());
  const visibility = useDocumentVisibility();
  const network = useOnline();
  let generation = 0;
  let disposed = false;
  let identity = "";
  let consumed = false;
  let inFlight = false;
  let queuedOnline = false;
  let onlineRetryAt = 0;
  let lastAttemptAt = 0;
  let lastOnlineRequest = policy.onlineRequest();
  let resolved: { point: Position; address: string; at: number } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  function persist() {
    if (!identity) return;
    try {
      localStorage.setItem(
        identity,
        JSON.stringify({
          consumed,
          retryAt: retryAt.value,
          queuedOnline,
          onlineRetryAt,
        }),
      );
    } catch {
      // The server also enforces the installation allowance and shared cooldown.
    }
  }
  function reconcile() {
    const id = driverId();
    const installation = policy.installation();
    const nextIdentity =
      id && installation ? `tayyn.address.${id}.${installation}` : "";
    if (identity !== nextIdentity) {
      ++generation;
      identity = nextIdentity;
      resolved = undefined;
      consumed = false;
      retryAt.value = 0;
      queuedOnline = false;
      onlineRetryAt = 0;
      try {
        const saved = JSON.parse(localStorage.getItem(identity) || "null");
        consumed = saved?.consumed === true;
        if (Number.isFinite(saved?.retryAt)) retryAt.value = saved.retryAt;
        queuedOnline = saved?.queuedOnline === true;
        if (Number.isFinite(saved?.onlineRetryAt))
          onlineRetryAt = saved.onlineRetryAt;
      } catch {
        // An invalid local cache cannot grant server access or extra quota.
      }
    }
    const point = position();
    // Hiding the app only hides the label. Keep a still-fresh result so a return
    // at the same position does not spend quota or leave an empty cooldown.
    address.value =
      enabled() &&
      point &&
      visibility.value === "visible" &&
      resolved &&
      clock.value - resolved.at < interval &&
      distance(point, resolved.point) < 150
        ? resolved.address
        : "";
  }
  function ready() {
    return !!(
      !disposed &&
      !policy.transitionPending() &&
      identity &&
      enabled() &&
      position() &&
      visibility.value === "visible" &&
      network.value &&
      policy.connected()
    );
  }
  function schedule() {
    reconcile();
    if (inFlight || !ready() || Date.now() - lastAttemptAt < 1000) return;
    if (queuedOnline && policy.online()) {
      if (clock.value >= onlineRetryAt) void request("online");
    } else if (policy.online()) {
      if (clock.value >= retryAt.value) void request("refresh");
    } else if (!consumed) void request("off-shift");
  }
  async function request(purpose: Purpose) {
    const point = position();
    const id = driverId();
    if (inFlight || !ready() || !point || !id) return;
    inFlight = true;
    lastAttemptAt = Date.now();
    const current = generation;
    if (purpose === "off-shift") {
      // Survives reload/swipe-away, including a lost response. Do not retry
      // convenience lookups indefinitely when the provider is unavailable.
      consumed = true;
      persist();
    }
    try {
      const { data } = await api.post<AddressReply>(
        `/geo/drivers/${encodeURIComponent(id)}/address`,
        {
          purpose,
          ...(purpose === "off-shift"
            ? {
                position: {
                  lat: point.lat,
                  lng: point.lng,
                  capturedAt: policy.capturedAt(),
                },
              }
            : {}),
        },
      );
      if (generation !== current || driverId() !== id) return;
      const next = Date.parse(data.retryAt || "");
      // The shared server deadline may already be nearly due. Do not add a
      // new five-minute wait on this phone; one-second scheduling bounds
      // catch-up retries when a deadline elapsed during network delivery.
      retryAt.value = Number.isFinite(next) ? next : Date.now() + interval;
      if (data.convenienceConsumed) consumed = true;
      if (purpose === "online") {
        queuedOnline = data.reason === "pending";
        onlineRetryAt = queuedOnline ? retryAt.value : 0;
      }
      persist();
      const resolvedAt = Date.parse(data.resolvedAt || "");
      if (
        data.address &&
        data.position &&
        Number.isFinite(resolvedAt) &&
        Date.now() - resolvedAt < interval
      ) {
        resolved = {
          point: data.position,
          address: data.address,
          at: resolvedAt,
        };
      }
      reconcile();
    } catch {
      if (generation === current) {
        retryAt.value = Date.now() + interval;
        // A transport loss does not tell us whether Online demand reached
        // the server. Retain it for a short probe after reconnect/relaunch;
        // the server owns admission and never duplicates a provider attempt.
        if (purpose === "online") onlineRetryAt = Date.now() + 1000;
        persist();
      }
      // Coordinates remain usable for auth, network, quota and provider failures.
    } finally {
      inFlight = false;
      schedule();
    }
  }
  const stop = watch(
    () =>
      [
        position()?.lat,
        position()?.lng,
        driverId(),
        enabled(),
        visibility.value,
        network.value,
        policy.online(),
        policy.connected(),
        policy.installation(),
        policy.onlineRequest(),
        policy.transitionPending(),
      ] as const,
    () => {
      reconcile();
      const requested = policy.onlineRequest();
      if (requested !== lastOnlineRequest) {
        lastOnlineRequest = requested;
        queuedOnline = true;
        onlineRetryAt = 0;
        persist();
      }
      schedule();
    },
    { immediate: true },
  );
  onMounted(() => {
    timer = setInterval(() => {
      clock.value = Date.now();
      schedule();
    }, 1000);
  });
  onUnmounted(() => {
    disposed = true;
    ++generation;
    clearInterval(timer);
    stop();
  });
  return { address };
}
