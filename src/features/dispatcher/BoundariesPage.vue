<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { onBeforeRouteLeave, useRoute } from "vue-router";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";
import { Label } from "@/shared/ui/label";
import { Badge } from "@/shared/ui/badge";
import { adminApi, errorMessage } from "@/shared/api";
import { hasYandexMapsApiKey, loadYandexMaps } from "@/shared/maps/yandex";
import type { District, Point } from "./domain";
const referenceText: Record<string, string> = {
  Мир: "Mira giryan yeri\nAytakow shayoly\nSahyoly arcabil sag tarapam katowski karta boyunca seredende",
  Микрорайон:
    "Mikrayonlar\nAytakowdan gurbansolta aralyk\nMagistralny bn mir aralyk",
  "30мкр, Гуртлы":
    "30 gurtly\n1 may cehow gurbansoltana cenli\nBeylesem cehowdan kone gurtly cenli",
  "Хитровка, Бедев":
    "Hitrowka bedew\nGurbansoltandan obyeznoya cenli beylesem bedew bn gagarin aralyk",
  "Чоганлы, Гарадамак":
    "Coganly garadamak obyeznoydan asak tarapy garadamakdan cogalny",
  Центр:
    "Centr shayoly bilen cehow aralyk\nYokarsy maskowski asagam gurbansoltan",
  "Ачабил, Бекреве": "Arcabilem dusnukli bekrewani 1 maydan yokarsyny goymaly",
  "Анау, Гами": "Anew gami gurbansoltan magistralnydan anarsy",
  "Аркадаг, Ялкым": "Arkadag yalkymam kone gurtlydan anarsy",
};
const route = useRoute(),
  districts = ref<District[]>([]),
  selected = ref(""),
  loading = ref(true),
  error = ref(""),
  mapError = ref(""),
  coordinates = ref(""),
  pending = ref(false),
  saved = ref(false),
  dirty = ref(false),
  mapElement = ref<HTMLElement>();
const current = computed(() =>
  districts.value.find((d) => d.id === selected.value),
);
let map: any,
  y: any,
  disposed = false;
const polygons = new Map<string, any>(),
  originals = new Map<string, Point[][]>(),
  savedBoundaries = new Map<string, Point[][] | null>();
const colors = [
  "#17634b",
  "#b76b28",
  "#3b6c97",
  "#88558f",
  "#a4494a",
  "#697c32",
  "#447b7f",
  "#72654d",
  "#5b62a1",
];
function draft(d: District): Point[][] {
  const lat = Number(d.centerLat),
    lng = Number(d.centerLng),
    radius = Number(d.radiusKm) || 5;
  return [
    Array.from({ length: 32 }, (_, i) => {
      const angle = (i * 2 * Math.PI) / 32;
      return [
        lat + (Math.sin(angle) * radius) / 111.32,
        lng +
          (Math.cos(angle) * radius) /
            (111.32 * Math.cos((lat * Math.PI) / 180)),
      ] as Point;
    }),
  ];
}
function snapshot(coords: Point[][]): Point[][] {
  return structuredClone(coords);
}
function select(id: string) {
  if (pending.value) return;
  if (
    dirty.value &&
    !window.confirm(
      "Несохранённые изменения будут отменены. Перейти к другому району?",
    )
  )
    return;
  const previous = polygons.get(selected.value);
  if (previous) {
    previous.editor.stopEditing();
    const savedCoords = originals.get(selected.value);
    if (savedCoords) previous.geometry.setCoordinates(snapshot(savedCoords));
  }
  selected.value = id;
  coordinates.value = JSON.stringify(originals.get(id) ?? [], null, 2);
  dirty.value = false;
  saved.value = false;
  const polygon = polygons.get(id);
  if (polygon) {
    polygon.editor.startEditing();
    map.setBounds(polygon.geometry.getBounds(), {
      checkZoomRange: true,
      zoomMargin: 35,
    });
  }
}
function reset() {
  const district = current.value;
  if (!district || pending.value) return;
  if (
    !window.confirm(
      "Заменить текущую форму черновиком по центру района? Серверная граница изменится только после сохранения.",
    )
  )
    return;
  coordinates.value = JSON.stringify(draft(district), null, 2);
  polygons.get(district.id)?.geometry.setCoordinates(draft(district));
  dirty.value = true;
  saved.value = false;
}
function discard() {
  const coords = originals.get(selected.value);
  if (coords) {
    coordinates.value = JSON.stringify(coords, null, 2);
    polygons.get(selected.value)?.geometry.setCoordinates(snapshot(coords));
    dirty.value = false;
    saved.value = false;
  }
}
async function save() {
  const district = current.value,
    polygon = polygons.get(selected.value);
  if (!district || pending.value) return;
  pending.value = true;
  error.value = "";
  saved.value = false;
  try {
    const boundary = parseCoordinates();
    const latest = (
      await adminApi.get<District[]>("/admin/districts")
    ).data.find((d) => d.id === district.id);
    if (
      !latest ||
      JSON.stringify(latest.boundary ?? null) !==
        JSON.stringify(savedBoundaries.get(district.id) ?? null)
    )
      throw new Error(
        "Граница изменена в другой сессии. Перезагрузите страницу, чтобы не затереть чужие правки.",
      );
    const { data } = await adminApi.patch<District>(
      `/admin/districts/${district.id}/boundary`,
      { boundary },
    );
    districts.value = districts.value.map((d) => (d.id === data.id ? data : d));
    originals.set(district.id, snapshot(data.boundary ?? boundary));
    savedBoundaries.set(district.id, snapshot(data.boundary ?? boundary));
    coordinates.value = JSON.stringify(data.boundary ?? boundary, null, 2);
    polygon?.geometry.setCoordinates(snapshot(data.boundary ?? boundary));
    polygon?.options.set("strokeStyle", "solid");
    dirty.value = false;
    saved.value = true;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}
function parseCoordinates(): Point[][] {
  const value: unknown = JSON.parse(coordinates.value);
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some(
      (r) =>
        !Array.isArray(r) ||
        r.length < 3 ||
        r.some(
          (p) =>
            !Array.isArray(p) ||
            p.length !== 2 ||
            typeof p[0] !== "number" ||
            typeof p[1] !== "number" ||
            !Number.isFinite(p[0]) ||
            !Number.isFinite(p[1]) ||
            Math.abs(p[0]) > 90 ||
            Math.abs(p[1]) > 180,
        ),
    )
  )
    throw new Error(
      "Укажите массив контуров с минимум 3 точками [широта, долгота].",
    );
  return value as Point[][];
}
function previewCoordinates() {
  try {
    const value = parseCoordinates();
    polygons.get(selected.value)?.geometry.setCoordinates(value);
    error.value = "";
  } catch (e) {
    error.value = errorMessage(e);
  }
}
function unload(e: BeforeUnloadEvent) {
  if (dirty.value || pending.value) {
    e.preventDefault();
    e.returnValue = "";
  }
}
onBeforeRouteLeave(
  () =>
    !pending.value &&
    (!dirty.value ||
      window.confirm("Есть несохранённые изменения. Покинуть редактор?")),
);
onMounted(async () => {
  window.addEventListener("beforeunload", unload);
  try {
    districts.value = (await adminApi.get<District[]>("/admin/districts")).data;
    districts.value.forEach((d) => {
      originals.set(
        d.id,
        snapshot(d.boundary?.[0]?.length ? d.boundary : draft(d)),
      );
      savedBoundaries.set(d.id, d.boundary ? snapshot(d.boundary) : null);
    });
    select(String(route.query.district || districts.value[0]?.id || ""));
    if (!hasYandexMapsApiKey()) {
      mapError.value =
        "Карта недоступна: не задан ключ Yandex Maps API. Координаты доступны ниже.";
      return;
    }
    y = await loadYandexMaps();
    if (disposed || !mapElement.value) return;
    map = new y.Map(mapElement.value, {
      center: [37.9601, 58.3261],
      zoom: 12,
      controls: ["zoomControl"],
    });
    districts.value.forEach((d, i) => {
      const geometry = d.boundary?.[0]?.length ? d.boundary : draft(d);
      originals.set(d.id, snapshot(geometry));
      const polygon = new y.Polygon(
        snapshot(geometry),
        {},
        {
          fillColor: colors[i % colors.length] + "25",
          strokeColor: colors[i % colors.length],
          strokeWidth: 2,
          strokeStyle: d.boundary ? "solid" : "shortdash",
        },
      );
      polygon.geometry.events.add("change", () => {
        if (selected.value === d.id) {
          coordinates.value = JSON.stringify(
            polygon.geometry.getCoordinates(),
            null,
            2,
          );
          dirty.value = true;
          saved.value = false;
        }
      });
      map.geoObjects.add(polygon);
      polygons.set(d.id, polygon);
    });
    select(String(route.query.district || districts.value[0]?.id || ""));
  } catch (e) {
    if (districts.value.length) mapError.value = errorMessage(e);
    else error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
});
onUnmounted(() => {
  disposed = true;
  map?.destroy();
  window.removeEventListener("beforeunload", unload);
});
</script>
<template>
  <div class="space-y-5">
    <header>
      <p class="eyebrow">Территория работы</p>
      <h1 class="page-heading">Границы районов</h1>
      <p class="mt-2 max-w-2xl text-sm text-muted-foreground">
        Выберите район и перемещайте вершины на карте. Изменения отправляются на
        сервер только по кнопке «Сохранить».
      </p>
    </header>
    <p v-if="loading" role="status" class="text-sm text-muted-foreground">
      Загрузка районов…
    </p>
    <p
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/30 p-4 text-sm text-destructive"
    >
      {{ error }}
    </p>
    <p
      v-if="mapError"
      role="status"
      class="rounded-lg bg-muted p-4 text-sm text-muted-foreground"
    >
      {{ mapError }}
    </p>
    <div class="grid gap-4 lg:grid-cols-[260px_1fr]">
      <aside class="space-y-3">
        <div class="overflow-hidden rounded-xl border bg-card">
          <button
            v-for="district in districts"
            :key="district.id"
            type="button"
            class="flex w-full items-center justify-between gap-3 border-b p-4 text-left text-sm last:border-0 hover:bg-muted"
            :class="
              selected === district.id
                ? 'bg-primary/10 font-semibold text-primary'
                : ''
            "
            :aria-pressed="selected === district.id"
            :disabled="pending"
            @click="select(district.id)"
          >
            <span>{{ district.name }}</span
            ><Badge variant="outline">{{
              district.boundary ? "Сохранён" : "Черновик"
            }}</Badge>
          </button>
        </div>
        <div
          v-if="current && referenceText[current.name]"
          class="rounded-xl border bg-card p-4"
        >
          <h2 class="text-xs font-semibold text-muted-foreground">
            Описание границы
          </h2>
          <p class="mt-2 whitespace-pre-line text-sm">
            {{ referenceText[current.name] }}
          </p>
        </div>
        <p class="text-xs leading-relaxed text-muted-foreground">
          Сплошная линия — сохранённая граница. Пунктир — предварительный контур
          по центру и радиусу района.
        </p>
      </aside>
      <div class="min-w-0 space-y-3">
        <div
          ref="mapElement"
          class="h-[55dvh] min-h-80 overflow-hidden rounded-xl border bg-muted"
          aria-label="Редактор границ районов"
        />
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap gap-2">
            <Button
              variant="outline"
              :disabled="!current || pending"
              @click="reset"
              >Черновик по центру</Button
            ><Button
              variant="ghost"
              :disabled="!dirty || pending"
              @click="discard"
              >Отменить правки</Button
            >
          </div>
          <Button :disabled="!current || pending" @click="save">{{
            pending ? "Сохраняем…" : "Сохранить границу"
          }}</Button>
        </div>
        <details
          v-if="current"
          :open="!!mapError"
          class="rounded-xl border bg-card p-4"
        >
          <summary class="cursor-pointer text-sm font-medium">
            Редактировать координаты вручную
          </summary>
          <div class="mt-4 space-y-3">
            <Label for="boundary-coordinates"
              >Контуры: массив точек [широта, долгота]</Label
            >
            <p class="text-xs text-muted-foreground">
              Все контуры сохраняются. Проверьте координаты перед отправкой. Эта
              форма и карта редактируют одну границу.
            </p>
            <Textarea
              id="boundary-coordinates"
              v-model="coordinates"
              rows="10"
              class="font-mono text-xs"
              :disabled="pending"
              @input="
                dirty = true;
                saved = false;
              "
            /><Button
              v-if="!mapError"
              variant="outline"
              :disabled="pending"
              @click="previewCoordinates"
              >Показать на карте</Button
            >
          </div>
        </details>
        <p v-if="saved" role="status" class="text-sm text-primary">
          Граница сохранена на сервере.
        </p>
        <p
          v-else-if="dirty"
          role="status"
          class="text-sm text-muted-foreground"
        >
          Есть несохранённые изменения.
        </p>
      </div>
    </div>
  </div>
</template>
