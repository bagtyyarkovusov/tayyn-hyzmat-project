<script setup lang="ts">
import IncomingOrder from "./components/IncomingOrder.vue";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { LocateFixed, MapPin } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { loadYandexMaps, hasYandexMapsApiKey } from "@/shared/maps/yandex";
import { useDriver } from "./useDriver";
import ActiveTrip from "./components/ActiveTrip.vue";
import { tripMarkerPoints, validCoordinatePair } from "./map-markers";

const { state, enableGps } = useDriver();
const container = ref<HTMLElement | null>(null);
const error = ref("");
const loading = ref(true);
// The vendor SDK has no official TS interface. Keep that boundary confined here.
let map: any;
let ymaps: any;
let ownMarker: any = null;
let pickupMarker: any = null;
let destinationMarker: any = null;
let alive = true;

function removeMarker(marker: any) {
  if (!marker || !map) return;
  map.geoObjects.remove(marker);
}

function setOwnMarker() {
  if (!map || !ymaps) return;
  const point = state.position
    ? validCoordinatePair(state.position.lat, state.position.lng)
    : null;
  if (!point) {
    removeMarker(ownMarker);
    ownMarker = null;
    return;
  }

  const stale = Date.now() - state.locationUpdatedAt > 60_000;
  const hint = stale
    ? `Последнее положение · ${new Date(state.locationUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "Текущее положение";
  if (!ownMarker) {
    ownMarker = new ymaps.Placemark(
      [point.lat, point.lng],
      { hintContent: hint, balloonContent: hint },
      {
        preset: stale
          ? "islands:grayCircleDotIcon"
          : "islands:blueCircleDotIcon",
        zIndex: 1000,
      },
    );
    map.geoObjects.add(ownMarker);
  } else {
    ownMarker.geometry.setCoordinates([point.lat, point.lng]);
    ownMarker.options.set(
      "preset",
      stale ? "islands:grayCircleDotIcon" : "islands:blueCircleDotIcon",
    );
    ownMarker.properties.set({ hintContent: hint, balloonContent: hint });
  }
}

function setTripMarker(
  current: any,
  point: { lat: number; lng: number } | null,
  preset: string,
  hint: string,
  zIndex: number,
) {
  if (!map || !ymaps) return current;
  if (!point) {
    removeMarker(current);
    return null;
  }
  if (!current) {
    current = new ymaps.Placemark(
      [point.lat, point.lng],
      { hintContent: hint, balloonContent: hint },
      { preset, zIndex },
    );
    map.geoObjects.add(current);
  } else {
    current.geometry.setCoordinates([point.lat, point.lng]);
    current.options.set("preset", preset);
    current.options.set("zIndex", zIndex);
    current.properties.set({ hintContent: hint, balloonContent: hint });
  }
  return current;
}

function draw() {
  if (!map || !ymaps) return;
  setOwnMarker();
  const points = tripMarkerPoints(state.active);
  const started = state.active?.status === "STARTED";
  pickupMarker = setTripMarker(
    pickupMarker,
    points.pickup,
    started ? "islands:grayCircleDotIcon" : "islands:redCircleDotIcon",
    "Точка подачи",
    started ? 300 : 900,
  );
  destinationMarker = setTripMarker(
    destinationMarker,
    points.destination,
    started ? "islands:redCircleDotIcon" : "islands:grayCircleDotIcon",
    "Место назначения",
    started ? 900 : 300,
  );
}

async function init() {
  error.value = "";
  loading.value = true;
  try {
    if (!hasYandexMapsApiKey())
      throw new Error(
        "Ключ Яндекс Карт не настроен. Адреса текущей поездки доступны ниже.",
      );
    ymaps = await loadYandexMaps();
    if (!alive || !container.value) return;
    map = new ymaps.Map(container.value, {
      center: [37.9601, 58.3261],
      zoom: 12,
      controls: ["zoomControl"],
    });
    draw();
  } catch (e) {
    error.value =
      e instanceof Error
        ? e.message
        : "Не удалось загрузить карту. Проверьте подключение.";
  } finally {
    loading.value = false;
  }
}

function center() {
  const point = state.position
    ? validCoordinatePair(state.position.lat, state.position.lng)
    : null;
  if (point) {
    map?.setCenter([point.lat, point.lng], 15, { duration: 250 });
    if (Date.now() - state.locationUpdatedAt >= 60_000) void enableGps();
    return;
  }
  void enableGps();
}

watch(
  () => [state.position, state.active, state.locationUpdatedAt, state.clock],
  draw,
  {
    deep: true,
  },
);
onMounted(() => void init());
onUnmounted(() => {
  alive = false;
  ownMarker = null;
  pickupMarker = null;
  destinationMarker = null;
  map?.destroy();
});
</script>

<template>
  <div
    class="driver-map-shell -mx-5 -mt-6 flex h-[calc(100dvh-10rem)] min-h-0 w-[calc(100%+2.5rem)] flex-col md:-mx-6 md:-mt-8 md:w-[calc(100%+3rem)]"
  >
    <h1 class="sr-only">Карта водителя</h1>
    <IncomingOrder />
    <p
      v-if="state.gpsError"
      role="alert"
      class="px-3 py-2 text-sm text-destructive"
    >
      {{ state.gpsError }}
    </p>
    <section
      class="relative min-h-[28rem] flex-1 overflow-hidden bg-muted"
      aria-label="Карта водителя"
    >
      <div ref="container" class="absolute inset-0" />
      <Button
        variant="secondary"
        size="icon"
        class="absolute right-3 top-3 z-10 size-11 rounded-full bg-background/90 shadow-lg backdrop-blur"
        aria-label="Показать моё положение на карте"
        title="Моё положение"
        @click="center"
      >
        <LocateFixed class="size-5" aria-hidden="true" />
      </Button>
      <p
        v-if="loading"
        class="absolute inset-0 flex items-center justify-center bg-muted text-muted-foreground"
        role="status"
      >
        Загружаем карту…
      </p>
      <div
        v-if="error"
        class="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-muted p-6 text-center"
      >
        <MapPin class="size-8 text-muted-foreground" aria-hidden="true" />
        <p class="max-w-sm text-sm">{{ error }}</p>
        <Button variant="outline" @click="init">Повторить загрузку</Button>
      </div>
    </section>
    <ActiveTrip v-if="state.profile?.canControlShift !== false" />
    <p
      v-if="state.error"
      role="alert"
      class="px-3 py-2 text-sm text-destructive"
    >
      {{ state.error }}
    </p>
  </div>
</template>
