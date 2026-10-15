<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { adminApi, errorMessage } from "@/shared/api";
import { adminSession } from "@/features/auth/session";
import { hasYandexMapsApiKey, loadYandexMaps } from "@/shared/maps/yandex";
import { type Driver, type Page } from "./domain";
import { useResource } from "./useResource";
import PageState from "./components/PageState.vue";
const { data, loading, error, load } = useResource(
  async () =>
    (
      await adminApi.get<Page<Driver>>("/admin/drivers", {
        params: { status: "APPROVED", limit: 100 },
      })
    ).data.items,
  [],
  ["driver:status"],
);
const mapElement = ref<HTMLElement>(),
  mapError = ref("");
let map: any,
  y: any,
  disposed = false;
const markers = new Map<string, any>();
function render() {
  if (!map) return;
  data.value.forEach((d) => {
    if (d.lastLat == null || d.lastLng == null) return;
    const coords = [Number(d.lastLat), Number(d.lastLng)];
    let marker = markers.get(d.id);
    if (!marker) {
      marker = new y.Placemark(
        coords,
        {},
        {
          preset: d.isOnline
            ? "islands#greenCircleDotIcon"
            : "islands#grayCircleDotIcon",
        },
      );
      marker.events.add("click", () => {
        selected.value = d.id;
      });
      markers.set(d.id, marker);
      map.geoObjects.add(marker);
    } else {
      marker.geometry.setCoordinates(coords);
      marker.options.set(
        "preset",
        d.isOnline ? "islands#greenCircleDotIcon" : "islands#grayCircleDotIcon",
      );
    }
  });
}
const selected = ref("");
watch(data, render);
let off: (() => void) | undefined;
onMounted(async () => {
  off = adminSession.on("driver:location", () => {
    void load();
  });
  if (!hasYandexMapsApiKey()) {
    mapError.value = "Карта недоступна: не задан ключ Yandex Maps API";
    return;
  }
  try {
    y = await loadYandexMaps();
    if (disposed || !mapElement.value) return;
    map = new y.Map(mapElement.value, {
      center: [37.9601, 58.3261],
      zoom: 12,
      controls: ["zoomControl"],
    });
    render();
  } catch (e) {
    mapError.value = errorMessage(e);
  }
});
onUnmounted(() => {
  disposed = true;
  off?.();
  map?.destroy();
});
function focus(d: Driver) {
  selected.value = d.id;
  if (d.lastLat != null && d.lastLng != null)
    map?.setCenter([Number(d.lastLat), Number(d.lastLng)], 15);
}
</script>
<template>
  <div class="space-y-5">
    <header>
      <p class="eyebrow">В реальном времени</p>
      <h1 class="page-heading">Мониторинг</h1>
      <p class="mt-2 text-muted-foreground">
        {{ data.filter((d) => d.isOnline).length }} водителей на линии. Показаны
        последние полученные координаты.
      </p>
    </header>
    <PageState :loading="loading" :error="error" @retry="load" />
    <p v-if="mapError" role="alert" class="rounded-lg border p-4 text-sm">
      {{ mapError }}
    </p>
    <div class="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div
        ref="mapElement"
        class="h-[65dvh] min-h-80 rounded-xl border bg-muted"
        aria-label="Карта водителей"
      />
      <div class="max-h-[65dvh] space-y-2 overflow-y-auto">
        <article
          v-for="driver in data"
          :key="driver.id"
          class="w-full rounded-lg border bg-card p-4 text-left"
          :class="selected === driver.id ? 'border-primary' : ''"
        >
          <button
            type="button"
            class="w-full text-left font-medium hover:text-primary"
            @click="focus(driver)"
          >
            {{ driver.user.fullName }}
          </button>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ driver.currentVehicle?.plateNumber || "Нет машины" }} ·
            {{ driver.isOnline ? "На линии" : "Не в сети" }}
          </p>
          <p
            v-if="driver.lastLat == null"
            class="mt-1 text-xs text-muted-foreground"
          >
            Координат пока нет
          </p>
          <RouterLink
            v-if="selected === driver.id"
            :to="`/adminDrivers/${driver.id}`"
            class="mt-3 inline-block text-sm text-primary"
            @click.stop
            >Карточка водителя →</RouterLink
          >
        </article>
      </div>
    </div>
  </div>
</template>
