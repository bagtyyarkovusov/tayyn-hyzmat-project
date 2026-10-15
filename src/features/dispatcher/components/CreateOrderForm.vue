<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from "vue";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { adminApi, errorMessage } from "@/shared/api";
import { hasYandexMapsApiKey, loadYandexMaps } from "@/shared/maps/yandex";
import type { District } from "../domain";
const emit = defineEmits<{ created: [] }>();
const districts = ref<District[]>([]),
  pending = ref(false),
  error = ref(""),
  mapError = ref(""),
  mapElement = ref<HTMLElement>(),
  point = ref<[number, number] | null>(null);
const form = reactive({
  districtId: "",
  pickupAddress: "",
  dropoffAddress: "",
  clientPhone: "",
  priceEstimated: "",
  note: "",
});
let map: any,
  marker: any,
  disposed = false;
onMounted(async () => {
  try {
    districts.value = (await adminApi.get<District[]>("/districts")).data;
  } catch (e) {
    error.value = errorMessage(e);
  }
  if (!hasYandexMapsApiKey()) {
    mapError.value = "Карта недоступна. Выберите район ниже.";
    return;
  }
  try {
    const y = await loadYandexMaps();
    if (disposed || !mapElement.value) return;
    map = new y.Map(mapElement.value, {
      center: [37.9601, 58.3261],
      zoom: 12,
      controls: ["zoomControl"],
    });
    map.events.add("click", (e: any) => {
      const coords = e.get("coords") as [number, number];
      point.value = coords;
      if (marker) marker.geometry.setCoordinates(coords);
      else {
        marker = new y.Placemark(coords);
        map.geoObjects.add(marker);
      }
      void reverse(coords);
    });
  } catch (e) {
    mapError.value = errorMessage(e);
  }
});
onUnmounted(() => {
  disposed = true;
  map?.destroy();
});
async function reverse(coords: [number, number]) {
  try {
    const { data } = await adminApi.get<{ address?: string }>("/geo/reverse", {
      params: { lat: coords[0], lng: coords[1] },
    });
    if (point.value === coords && data.address)
      form.pickupAddress = data.address;
  } catch {
    /* Address remains manually editable when geocoder is unavailable. */
  }
}
async function submit() {
  pending.value = true;
  error.value = "";
  try {
    await adminApi.post("/admin/orders", {
      ...Object.fromEntries(Object.entries(form).filter(([, v]) => v !== "")),
      priceEstimated: form.priceEstimated
        ? Number(form.priceEstimated)
        : undefined,
      ...(point.value
        ? { pickupLat: point.value[0], pickupLng: point.value[1] }
        : {}),
    });
    emit("created");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <form class="space-y-4" @submit.prevent="submit">
    <div>
      <p class="mb-2 text-sm font-medium">Точка подачи</p>
      <div
        v-if="!mapError"
        ref="mapElement"
        class="h-52 overflow-hidden rounded-lg border"
        aria-label="Карта выбора точки подачи"
      />
      <p
        v-if="mapError"
        class="rounded-lg bg-muted p-3 text-sm text-muted-foreground"
      >
        {{ mapError }}
      </p>
      <p v-if="point" class="mt-2 text-xs text-muted-foreground">
        Выбрано: {{ point[0].toFixed(5) }}, {{ point[1].toFixed(5) }}
        <button
          type="button"
          class="ml-2 underline"
          @click="
            point = null;
            marker && map.geoObjects.remove(marker);
            marker = null;
          "
        >
          Убрать точку
        </button>
      </p>
    </div>
    <div class="space-y-2">
      <Label for="order-region">Район</Label
      ><select
        id="order-region"
        v-model="form.districtId"
        class="native-select w-full"
        :required="!point"
      >
        <option value="">
          {{ point ? "Определить по точке" : "Выберите район" }}
        </option>
        <option v-for="d in districts" :key="d.id" :value="d.id">
          {{ d.name }}
        </option>
      </select>
    </div>
    <div class="grid gap-4 sm:grid-cols-2">
      <div class="space-y-2">
        <Label for="pickup">Откуда</Label
        ><Input
          id="pickup"
          v-model="form.pickupAddress"
          maxlength="300"
          placeholder="Улица, дом, ориентир"
        />
      </div>
      <div class="space-y-2">
        <Label for="dropoff">Куда</Label
        ><Input
          id="dropoff"
          v-model="form.dropoffAddress"
          maxlength="300"
          placeholder="Адрес назначения"
        />
      </div>
      <div class="space-y-2">
        <Label for="client-phone">Телефон клиента</Label
        ><Input
          id="client-phone"
          v-model="form.clientPhone"
          type="tel"
          maxlength="20"
          placeholder="+993…"
        />
      </div>
      <div class="space-y-2">
        <Label for="order-price">Стоимость, TMT</Label
        ><Input
          id="order-price"
          v-model="form.priceEstimated"
          type="number"
          min="0.01"
          step="0.01"
          placeholder="Необязательно"
        />
      </div>
    </div>
    <div class="space-y-2">
      <Label for="order-note">Комментарий</Label
      ><Textarea
        id="order-note"
        v-model="form.note"
        maxlength="500"
        placeholder="Подъезд, багаж или пожелания"
      />
    </div>
    <p v-if="error" role="alert" class="text-sm text-destructive">
      {{ error }}
    </p>
    <div class="flex justify-end border-t pt-4">
      <Button
        type="submit"
        :disabled="pending || (!form.districtId && !point)"
        >{{ pending ? "Создаём…" : "Отправить водителям" }}</Button
      >
    </div>
  </form>
</template>
