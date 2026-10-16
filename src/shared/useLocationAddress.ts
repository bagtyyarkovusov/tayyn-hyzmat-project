import { onMounted, onUnmounted, ref, watch } from "vue";
import { useDocumentVisibility } from "@vueuse/core";

interface Position {
  lat: number;
  lng: number;
}
interface AddressReply {
  address: string | null;
  position: Position | null;
}
interface AddressApi {
  get<T>(path: string): Promise<{ data: T }>;
}
function distance(a: Position, b: Position) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) *
      Math.cos(b.lat * rad) *
      Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

/** Best-effort visible-screen demand. GPS and availability never depend on it. */
export function useLocationAddress(
  position: () => Position | null,
  driverId: () => string | undefined,
  api: AddressApi,
  enabled: () => boolean = () => true,
) {
  const address = ref("");
  const visibility = useDocumentVisibility();
  let generation = 0;
  let lastRequestAt = 0;
  let lastDriver: string | undefined;
  let resolved:
    | { driverId: string; point: Position; address: string; at: number }
    | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  async function reconcile() {
    const point = position(),
      id = driverId();
    const current = ++generation;
    if (id !== lastDriver) {
      lastRequestAt = 0;
      resolved = undefined;
      lastDriver = id;
    }
    if (!enabled() || !point || !id) {
      address.value = "";
      resolved = undefined;
      return;
    }
    address.value =
      resolved &&
      resolved.driverId === id &&
      Date.now() - resolved.at < 300_000 &&
      distance(point, resolved.point) < 150
        ? resolved.address
        : "";
    if (
      visibility.value !== "visible" ||
      !navigator.onLine ||
      Date.now() - lastRequestAt < 30_000
    )
      return;
    lastRequestAt = Date.now();
    try {
      const { data } = await api.get<AddressReply>(
        `/geo/drivers/${encodeURIComponent(id)}/address`,
      );
      if (
        generation !== current ||
        driverId() !== id ||
        visibility.value !== "visible" ||
        !enabled()
      )
        return;
      const latest = position();
      if (!latest || !data.position || distance(latest, data.position) >= 150)
        return;
      if (data.address) {
        resolved = {
          driverId: id,
          point: data.position,
          address: data.address,
          at: Date.now(),
        };
        address.value = data.address;
      }
    } catch {
      /* Coordinates remain the fallback, including auth/provider/network failures. */
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
      ] as const,
    () => {
      void reconcile();
    },
    { immediate: true },
  );
  onMounted(() => {
    timer = setInterval(() => {
      void reconcile();
    }, 30_000);
  });
  onUnmounted(() => {
    ++generation;
    clearInterval(timer);
    stop();
  });
  return address;
}
