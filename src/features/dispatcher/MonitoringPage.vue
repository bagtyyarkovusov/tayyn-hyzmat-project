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
  DialogTrigger,
} from "@/shared/ui/dialog";
import MapDriverOffer from "./components/MapDriverOffer.vue";
import { canOfferToDriver } from "./private-offers";
import DriverMapInfo from "./components/DriverMapInfo.vue";
import { RouterLink } from "vue-router";
import { errorMessage } from "@/shared/api";

import { hasYandexMapsApiKey, loadYandexMaps } from "@/shared/maps/yandex";
import { type Driver } from "./domain";
import { useMonitoringFleet } from "./useMonitoringFleet";
import MonitoringRoster from "./components/MonitoringRoster.vue";
import PageState from "./components/PageState.vue";
const { drivers: data, loading, error, now, load } = useMonitoringFleet();
const search = ref("");
const region = ref("");
const status = ref("all");
const listOpen = ref(false);
let focusSelectionOnClose = false;
function focusSelectedDetails(event: Event) {
  if (!focusSelectionOnClose) return;
  focusSelectionOnClose = false;
  event.preventDefault();
  document.getElementById("selected-driver-close")?.focus();
}
const regions = computed(() =>
  [
    ...new Map(
      data.value
        .filter((d) => d.district)
        .map((d) => [d.district!.id, d.district!]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name, "ru")),
);
function state(d: Driver) {
  if (!d.isOnline) return "offline";
  const age = now.value - Date.parse(d.lastLocationAt ?? "");
  if (!coordinates(d) || !Number.isFinite(age) || age < 0 || age >= 60_000)
    return "stale";
  if (!d.isAvailable) return "busy";
  return "available";
}
const states = computed(() =>
  Object.fromEntries(data.value.map((driver) => [driver.id, state(driver)])),
);
const filtered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  const digits = query.replace(/\D/g, "");
  return data.value.filter(
    (d) =>
      (!region.value ||
        (region.value === "outside"
          ? !d.district
          : d.district?.id === region.value)) &&
      (status.value === "all" || state(d) === status.value) &&
      (!query ||
        [
          d.user.fullName,
          d.currentVehicle?.plateNumber ?? "",
          d.user.phone,
        ].some((value) => value.toLocaleLowerCase().includes(query)) ||
        (digits.length > 0 &&
          d.user.phone.replace(/\D/g, "").includes(digits))),
  );
});
const mapElement = ref<HTMLElement>(),
  mapError = ref("");
let map: any,
  y: any,
  disposed = false;
const markers = new Map<string, any>();
const selected = ref("");
const offerDriver = ref<Driver | null>(null);
const hovered = ref("");

const selectedDriver = computed(() =>
  data.value.find((d) => d.id === selected.value),
);
const hoveredDriver = computed(() =>
  data.value.find((d) => d.id === hovered.value),
);

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
    now.value - timestamp >= 0 &&
    now.value - timestamp < 60_000
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

onMounted(async () => {
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
  map?.destroy();
});
function focus(d: Driver) {
  selected.value = d.id;
  hovered.value = "";
  focusSelectionOnClose = listOpen.value;
  listOpen.value = false;
  const coords = coordinates(d);
  if (coords) map?.setCenter(coords, 15);
}
</script>
<template>
  <div class="space-y-3">
    <header>
      <h1 class="page-heading">Мониторинг</h1>
      <p v-if="!loading && !error" class="mt-1 text-sm text-muted-foreground">
        {{ data.length }} водителей ·
        {{ data.filter((d) => state(d) === "available").length }} свободны со
        свежим GPS.
      </p>
    </header>
    <PageState :loading="loading" :error="error" @retry="load" />
    <p v-if="mapError" role="alert" class="rounded-lg border p-4 text-sm">
      {{ mapError }}
    </p>
    <div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div class="relative min-w-0">
        <div
          ref="mapElement"
          v-show="!mapError"
          class="h-[calc(100dvh-20rem)] min-h-48 lg:h-[min(60dvh,640px)] lg:min-h-64 overflow-hidden rounded-lg border bg-muted"
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
            id="selected-driver-close"
            aria-label="Закрыть сведения о водителе"
            class="absolute right-1 top-1 flex size-11 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
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
            Нужен свободный водитель на линии со свежим GPS. Доступность
            предложения проверит сервер.
          </p>
          <RouterLink
            :to="`/adminDrivers/${selectedDriver.id}`"
            class="mt-2 inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4"
            >Карточка водителя</RouterLink
          >
        </section>
      </div>
      <div class="hidden lg:block">
        <MonitoringRoster
          id-prefix="desktop-fleet"
          v-model:search="search"
          v-model:region="region"
          v-model:status="status"
          :drivers="filtered"
          :regions="regions"
          :states="states"
          :total="data.length"
          :selected="selected"
          :loading="loading"
          :error="error"
          @select="focus"
        />
      </div>
    </div>
    <Dialog v-model:open="listOpen"
      ><DialogTrigger as-child
        ><Button variant="outline" class="min-h-11 w-full lg:hidden"
          >Водители · {{ data.length }}</Button
        ></DialogTrigger
      ><DialogContent
        @close-auto-focus="focusSelectedDetails"
        class="monitoring-sheet max-w-none w-full rounded-b-none p-3 lg:max-w-lg"
        ><DialogHeader class="px-1"
          ><DialogTitle>Водители</DialogTitle
          ><DialogDescription
            >Выберите водителя, чтобы показать его на карте.</DialogDescription
          ></DialogHeader
        ><MonitoringRoster
          id-prefix="mobile-fleet"
          v-model:search="search"
          v-model:region="region"
          v-model:status="status"
          :drivers="filtered"
          :regions="regions"
          :states="states"
          :total="data.length"
          :selected="selected"
          :loading="loading"
          :error="error"
          @select="focus" /></DialogContent
    ></Dialog>
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

<style>
.monitoring-sheet.app-dialog-content {
  top: auto;
  bottom: 0;
  left: 0;
  transform: none;
  max-height: calc(var(--app-viewport-height, 100dvh) - 1rem);
}
</style>
