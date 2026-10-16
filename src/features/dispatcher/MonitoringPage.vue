<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { X } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";
import MapDriverOffer from "./components/MapDriverOffer.vue";
import { canOfferToDriver } from "./private-offers";
import DriverMapInfo from "./components/DriverMapInfo.vue";
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
  [
    "driver:status",
    "order:accepted",
    "order:completed",
    "order:cancelled",
    "order:private-offer",
    "order:updated",
    "order:private-offer-ended",
  ],
);
const mapElement = ref<HTMLElement>(),
  mapError = ref("");
let map: any,
  y: any,
  disposed = false;
const markers = new Map<string, any>();
const selected = ref("");
const offerDriver = ref<Driver | null>(null);
const hovered = ref("");
const now = ref(Date.now());
const selectedDriver = computed(() =>
  data.value.find((d) => d.id === selected.value),
);
const hoveredDriver = computed(() =>
  data.value.find((d) => d.id === hovered.value),
);
let freshnessTimer: ReturnType<typeof setInterval> | undefined;
function coordinates(d: Driver): [number, number] | undefined {
  if (d.lastLat == null || d.lastLng == null) return;
  const lat = Number(d.lastLat),
    lng = Number(d.lastLng);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  )
    return;
  return [lat, lng];
}
function markerPreset(d: Driver) {
  const timestamp = Date.parse(d.lastLocationAt ?? "");
  return d.isOnline &&
    Number.isFinite(timestamp) &&
    now.value - timestamp <= 60_000
    ? "islands#greenCircleDotIcon"
    : "islands#grayCircleDotIcon";
}
function render() {
  if (!map) return;
  for (const [id, marker] of markers) {
    if (!data.value.some((d) => d.id === id && coordinates(d))) {
      map.geoObjects.remove(marker);
      markers.delete(id);
    }
  }
  data.value.forEach((d) => {
    const coords = coordinates(d);
    if (!coords) return;
    let marker = markers.get(d.id);
    if (!marker) {
      marker = new y.Placemark(
        coords,
        {},
        {
          preset: markerPreset(d),
        },
      );
      marker.events.add("click", () => {
        selected.value = d.id;
        hovered.value = "";
      });
      marker.events.add("mouseenter", () => {
        hovered.value = d.id;
      });
      marker.events.add("mouseleave", () => {
        hovered.value = "";
      });
      markers.set(d.id, marker);
      map.geoObjects.add(marker);
    } else {
      marker.geometry.setCoordinates(coords);
      marker.options.set("preset", markerPreset(d));
    }
  });
}
// A location response can be newer than the periodic display clock. Evaluate
// eligibility at commit time instead of treating that fresh fix as future GPS.
watch(data, () => {
  now.value = Date.now();
});
watch([data, now], render);
let off: (() => void) | undefined;
onMounted(async () => {
  freshnessTimer = setInterval(() => {
    now.value = Date.now();
  }, 15_000);
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
  clearInterval(freshnessTimer);
  off?.();
  map?.destroy();
});
function focus(d: Driver) {
  selected.value = d.id;
  hovered.value = "";
  const coords = coordinates(d);
  if (coords) map?.setCenter(coords, 15);
}
</script>
<template>
  <div class="space-y-5">
    <header>
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
      <div class="relative min-w-0">
        <div
          ref="mapElement"
          v-show="!mapError"
          class="h-[65dvh] min-h-96 rounded-xl border bg-muted"
          aria-label="Карта водителей"
        />
        <section
          v-if="hoveredDriver"
          aria-label="Водитель на карте"
          class="pointer-events-none absolute left-3 top-3 z-10 w-64 max-w-[calc(100%-1.5rem)] rounded-lg border bg-card p-4 shadow-md"
        >
          <DriverMapInfo :driver="hoveredDriver" :now="now" />
        </section>
        <section
          v-if="selectedDriver && !hoveredDriver"
          aria-label="Выбранный водитель"
          :class="
            mapError
              ? 'relative'
              : 'absolute left-3 top-3 z-10 w-72 max-w-[calc(100%-1.5rem)]'
          "
          class="rounded-lg border bg-card p-4 shadow-md"
        >
          <button
            type="button"
            aria-label="Закрыть сведения о водителе"
            class="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            @click="selected = ''"
          >
            <X class="size-4" />
          </button>
          <div class="pr-5">
            <DriverMapInfo :driver="selectedDriver" :now="now" />
          </div>
          <Button
            class="mt-3 w-full"
            :disabled="!canOfferToDriver(selectedDriver, now)"
            @click="offerDriver = selectedDriver"
            >Предложить заказ</Button
          >
          <p
            v-if="!canOfferToDriver(selectedDriver, now)"
            class="mt-2 text-xs text-muted-foreground"
          >
            Нужен свободный водитель на линии со свежим GPS.
          </p>
          <RouterLink
            :to="`/adminDrivers/${selectedDriver.id}`"
            class="mt-3 inline-block text-sm text-primary underline underline-offset-4"
            >Карточка водителя</RouterLink
          >
        </section>
      </div>
      <div class="max-h-[65dvh] space-y-2 overflow-y-auto">
        <article
          v-for="driver in data"
          :key="driver.id"
          class="w-full rounded-lg border bg-card p-4 text-left"
          :class="selected === driver.id ? 'border-primary' : ''"
        >
          <button
            type="button"
            class="min-h-11 w-full text-left font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
            :aria-pressed="selected === driver.id"
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
    <Dialog :open="!!offerDriver" @update:open="!$event && (offerDriver = null)"
      ><DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        ><DialogHeader
          ><DialogTitle
            >Предложить заказ: {{ offerDriver?.user.fullName }}</DialogTitle
          ><DialogDescription
            >Личное предложение на 20 секунд. Район заказа останется
            прежним.</DialogDescription
          ></DialogHeader
        ><MapDriverOffer
          v-if="offerDriver"
          :driver-id="offerDriver.id"
          @offered="
            offerDriver = null;
            load();
          " /></DialogContent
    ></Dialog>
  </div>
</template>
