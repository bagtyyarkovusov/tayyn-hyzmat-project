<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { LocateFixed, MapPin } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { loadYandexMaps, hasYandexMapsApiKey } from "@/shared/maps/yandex";
import { useDriver } from "./useDriver";
import ActiveTrip from "./components/ActiveTrip.vue";
const { state, enableGps } = useDriver();
const container = ref<HTMLElement | null>(null),
  error = ref(""),
  loading = ref(true);
// The vendor SDK has no official TS interface. Keep that boundary confined here.
let map: any, ymaps: any;
let alive = true;
function draw() {
  if (!map || !ymaps) return;
  map.geoObjects.removeAll();
  for (const d of state.districts) {
    const lat = Number(d.centerLat),
      lng = Number(d.centerLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    map.geoObjects.add(
      new ymaps.Placemark(
        [lat, lng],
        { iconCaption: d.name },
        {
          preset:
            d.id === state.profile?.districtId
              ? "islands:greenCircleDotIcon"
              : "islands:grayCircleDotIcon",
        },
      ),
    );
  }
  if (state.position)
    map.geoObjects.add(
      new ymaps.Placemark(
        [state.position.lat, state.position.lng],
        { iconCaption: "Вы здесь" },
        { preset: "islands:blueCircleDotIcon" },
      ),
    );
  const o = state.active;
  if (o) {
    const drop =
      o.status === "STARTED" && o.dropoffLat != null && o.dropoffLng != null;
    const lat = drop ? o.dropoffLat : o.pickupLat,
      lng = drop ? o.dropoffLng : o.pickupLng;
    if (lat != null && lng != null)
      map.geoObjects.add(
        new ymaps.Placemark(
          [Number(lat), Number(lng)],
          { iconCaption: drop ? "Назначение" : "Подача" },
          { preset: "islands:redDotIcon" },
        ),
      );
  }
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
  if (state.position)
    map?.setCenter([state.position.lat, state.position.lng], 15);
  else enableGps();
}
watch(
  () => [
    state.position,
    state.districts,
    state.active,
    state.profile?.districtId,
  ],
  draw,
  { deep: true },
);
onMounted(() => void init());
onUnmounted(() => {
  alive = false;
  map?.destroy();
});
</script>
<template>
  <div class="mx-auto max-w-5xl space-y-5">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="page-heading">Карта</h1>
        <p class="muted mt-1 text-sm">Центры районов и текущая поездка.</p>
      </div>
      <Button variant="outline" @click="center"
        ><LocateFixed class="size-4" />Моё положение</Button
      >
    </header>
    <p v-if="state.gpsError" role="alert" class="text-sm text-destructive">
      {{ state.gpsError }}
    </p>
    <section
      class="relative min-h-[55dvh] overflow-hidden rounded-xl border bg-muted"
      aria-label="Карта районов"
    >
      <div ref="container" class="absolute inset-0" />
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
        <MapPin class="size-8 text-muted-foreground" />
        <p class="max-w-sm text-sm">{{ error }}</p>
        <Button variant="outline" @click="init">Повторить загрузку</Button>
      </div>
    </section>
    <div class="muted flex flex-wrap gap-4 text-xs">
      <span>Зелёный: ваш район</span><span>Синий: ваше положение</span
      ><span>Красный: адрес поездки</span>
    </div>
    <ActiveTrip />
    <p v-if="state.error" role="alert" class="text-sm text-destructive">
      {{ state.error }}
    </p>
  </div>
</template>
