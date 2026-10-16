import { onMounted, onUnmounted, ref, shallowRef } from "vue";
import { adminApi, errorMessage } from "@/shared/api";
import { adminSession } from "@/features/auth/session";
import type { Driver, Page } from "./domain";
import { canOfferToDriver } from "./private-offers";

interface LocationUpdate {
  driverId: string;
  lat: number;
  lng: number;
  recordedAt: string;
}

export function useMonitoringFleet() {
  const drivers = shallowRef<Driver[]>([]);
  const loading = ref(true);
  const error = ref("");
  const now = ref(Date.now());
  let alive = true;
  let running = false;
  let queued = false;
  let lastRead = 0;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  let reconcile: ReturnType<typeof setInterval> | undefined;
  const locations = new Map<string, LocationUpdate>();
  const off: (() => void)[] = [];
  function patch(driver: Driver, update?: LocationUpdate): Driver {
    if (
      !update ||
      Date.parse(update.recordedAt) <
        Date.parse(driver.lastLocationAt ?? "1970-01-01")
    )
      return driver;
    return {
      ...driver,
      lastLat: update.lat,
      lastLng: update.lng,
      lastLocationAt: update.recordedAt,
    };
  }
  async function load() {
    if (!alive) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    loading.value = drivers.value.length === 0;
    lastRead = Date.now();
    try {
      const fleet = new Map<string, Driver>();
      let page = 1;
      let total = 0;
      do {
        const response = await adminApi.get<Page<Driver>>("/admin/drivers", {
          params: { status: "APPROVED", page, limit: 100 },
        });
        if (!alive) return;
        total = response.data.total;
        const previousSize = fleet.size;
        for (const driver of response.data.items)
          fleet.set(driver.id, patch(driver, locations.get(driver.id)));
        if (!response.data.items.length || fleet.size === previousSize) break;
        page++;
      } while (fleet.size < total);
      if (fleet.size < total)
        throw new Error("Список водителей изменился. Обновите данные.");
      // Preserve existing row positions through location/status updates. New rows
      // start with available drivers, then names; existing selection never jumps.
      const existing = drivers.value
        .map((driver) => fleet.get(driver.id))
        .filter((driver): driver is Driver => !!driver);
      const ids = new Set(existing.map((driver) => driver.id));
      now.value = Date.now();
      const added = [...fleet.values()]
        .filter((driver) => !ids.has(driver.id))
        .sort(
          (a, b) =>
            Number(canOfferToDriver(b, now.value)) -
              Number(canOfferToDriver(a, now.value)) ||
            a.user.fullName.localeCompare(b.user.fullName, "ru"),
        );
      drivers.value = [...existing, ...added];
      error.value = "";
    } catch (cause) {
      if (alive) error.value = errorMessage(cause);
    } finally {
      running = false;
      if (alive) {
        loading.value = false;
        if (queued) {
          queued = false;
          schedule();
        }
      }
    }
  }
  function schedule() {
    if (!alive || scheduled) return;
    scheduled = setTimeout(
      () => {
        scheduled = undefined;
        void load();
      },
      Math.max(500, 5000 - (Date.now() - lastRead)),
    );
  }
  function location(update: LocationUpdate) {
    now.value = Date.now();
    const age = Date.now() - Date.parse(update.recordedAt);
    if (
      !Number.isFinite(update.lat) ||
      !Number.isFinite(update.lng) ||
      Math.abs(update.lat) > 90 ||
      Math.abs(update.lng) > 180 ||
      !Number.isFinite(age) ||
      age < -5000
    )
      return;
    const previous = locations.get(update.driverId);
    if (
      previous &&
      Date.parse(previous.recordedAt) > Date.parse(update.recordedAt)
    )
      return;
    locations.set(update.driverId, update);
    if (!drivers.value.some((driver) => driver.id === update.driverId)) {
      schedule();
      return;
    }
    drivers.value = drivers.value.map((driver) =>
      driver.id === update.driverId ? patch(driver, update) : driver,
    );
  }
  function visible() {
    if (document.visibilityState === "visible") schedule();
  }
  onMounted(() => {
    void load();
    off.push(adminSession.on("driver:location", location));
    for (const event of [
      "connect",
      "driver:status",
      "driver:registered",
      "order:accepted",
      "order:completed",
      "order:cancelled",
      "order:updated",
      "order:private-offer-ended",
      "balance:updated",
    ])
      off.push(adminSession.on(event, schedule));
    clock = setInterval(() => {
      now.value = Date.now();
    }, 1000);
    reconcile = setInterval(visible, 30_000);
    document.addEventListener("visibilitychange", visible);
  });
  onUnmounted(() => {
    alive = false;
    clearTimeout(scheduled);
    clearInterval(clock);
    clearInterval(reconcile);
    off.forEach((stop) => stop());
    document.removeEventListener("visibilitychange", visible);
  });
  return { drivers, loading, error, now, load };
}
