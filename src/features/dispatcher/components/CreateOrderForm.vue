<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from "vue";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import PhoneInput from "@/shared/ui/phone-input/PhoneInput.vue";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { isTurkmenPhone, phoneError } from "@/shared/phone";
import { adminApi, errorMessage } from "@/shared/api";
import { hasYandexMapsApiKey, loadYandexMaps } from "@/shared/maps/yandex";
import PrivateOfferDriverPicker from "./PrivateOfferDriverPicker.vue";
import { adminSession } from "@/features/auth/session";
import type { District } from "../domain";
const props = defineProps<{ initialDriverId?: string }>();
const mode = ref(props.initialDriverId ? "private" : "public");
const privateDriverId = ref(props.initialDriverId ?? "");
const emit = defineEmits<{ created: [] }>();
const districts = ref<District[]>([]),
  pending = ref(false),
  error = ref(""),
  mapError = ref(""),
  mapElement = ref<HTMLElement>(),
  point = ref<[number, number] | null>(null);
const pickMode = ref<"pickup" | "dropoff">("pickup");
const destination = ref<[number, number] | null>(null);
const edited = reactive({ pickup: false, dropoff: false });
const versions = { pickup: 0, dropoff: 0 };
const form = reactive({
  districtId: "",
  pickupAddress: "",
  dropoffAddress: "",
  clientPhone: "+993",
  priceEstimated: "",
  note: "",
  broadcastAfterPrivateExpiry: true,
});
let map: any,
  marker: any,
  destinationMarker: any,
  disposed = false;
onMounted(async () => {
  try {
    districts.value = (await adminApi.get<District[]>("/districts")).data;
  } catch (e) {
    error.value = errorMessage(e);
  }
  if (!hasYandexMapsApiKey()) {
    mapError.value =
      "Карта недоступна. Заказ можно создать без точек на карте.";
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
      const mode = pickMode.value;
      if (mode === "pickup") {
        point.value = coords;
        if (marker) marker.geometry.setCoordinates(coords);
        else {
          marker = new y.Placemark(
            coords,
            {},
            { preset: "islands#greenCircleIcon" },
          );
          map.geoObjects.add(marker);
        }
      } else {
        destination.value = coords;
        if (destinationMarker)
          destinationMarker.geometry.setCoordinates(coords);
        else {
          destinationMarker = new y.Placemark(
            coords,
            {},
            { preset: "islands#redCircleIcon" },
          );
          map.geoObjects.add(destinationMarker);
        }
      }
      void reverse(coords, mode);
    });
  } catch (e) {
    mapError.value = errorMessage(e);
  }
});
onUnmounted(() => {
  disposed = true;
  map?.destroy();
});
async function reverse(
  coords: [number, number],
  mode: "pickup" | "dropoff" = "pickup",
) {
  if (edited[mode]) return;
  const version = ++versions[mode];
  try {
    const { data } = await adminApi.get<{ address?: string }>("/geo/reverse", {
      params: { lat: coords[0], lng: coords[1] },
    });
    if (
      !disposed &&
      !edited[mode] &&
      version === versions[mode] &&
      data.address
    )
      form[mode === "pickup" ? "pickupAddress" : "dropoffAddress"] =
        data.address;
  } catch {
    /* Address remains manually editable when geocoder is unavailable. */
  }
}
async function submit() {
  if (pending.value) return;
  const phone = form.clientPhone.trim();
  if (!form.districtId) {
    error.value = "Выберите район";
    return;
  }
  if (!isTurkmenPhone(phone)) {
    error.value = phoneError;
    return;
  }
  if (
    !Number.isFinite(Number(form.priceEstimated)) ||
    Number(form.priceEstimated) <= 0
  ) {
    error.value = "Укажите стоимость больше нуля в TMT";
    return;
  }
  if (mode.value === "private" && !privateDriverId.value) {
    error.value = "Выберите водителя для личного предложения";
    return;
  }
  const userId = adminSession.state.user?.id;
  pending.value = true;
  error.value = "";
  try {
    await adminApi.post("/admin/orders", {
      ...Object.fromEntries(Object.entries(form).filter(([, v]) => v !== "")),
      ...(mode.value === "private"
        ? { privateOfferDriverId: privateDriverId.value }
        : {}),
      clientPhone: phone,
      priceEstimated: Number(form.priceEstimated),
      ...(point.value
        ? { pickupLat: point.value[0], pickupLng: point.value[1] }
        : {}),
      ...(destination.value
        ? { dropoffLat: destination.value[0], dropoffLng: destination.value[1] }
        : {}),
    });
    if (!disposed && userId === adminSession.state.user?.id) emit("created");
  } catch (e) {
    if (!disposed && userId === adminSession.state.user?.id)
      error.value = errorMessage(e);
  } finally {
    if (!disposed) pending.value = false;
  }
}
</script>
<template>
  <form class="order-form space-y-5" @submit.prevent="submit">
    <div class="order-form-layout">
      <div class="order-form-primary space-y-5">
        <fieldset class="space-y-3">
          <legend class="mb-2 text-sm font-medium">
            Кому предложить заказ
          </legend>
          <div class="flex flex-wrap gap-2">
            <Button
              type="button"
              :variant="mode === 'public' ? 'default' : 'outline'"
              :aria-pressed="mode === 'public'"
              @click="mode = 'public'"
              >Всем в районе</Button
            >
            <Button
              type="button"
              :variant="mode === 'private' ? 'default' : 'outline'"
              :aria-pressed="mode === 'private'"
              @click="mode = 'private'"
              >Лично водителю</Button
            >
          </div>
          <PrivateOfferDriverPicker
            v-if="mode === 'private'"
            id="create-offer-driver"
            v-model="privateDriverId"
            :price-estimated="form.priceEstimated"
            :disabled="pending"
          />
          <label
            v-if="mode === 'private'"
            for="broadcast-after-private-expiry"
            class="flex items-start gap-3 rounded-md border border-border/70 p-3 text-sm"
          >
            <input
              id="broadcast-after-private-expiry"
              v-model="form.broadcastAfterPrivateExpiry"
              type="checkbox"
              class="mt-0.5 size-4 accent-primary"
              :disabled="pending"
            />
            <span>
              <span class="font-medium"
                >Предложить другим водителям после 20 секунд</span
              >
              <span class="mt-0.5 block text-xs text-muted-foreground">
                При включении заказ одновременно появится во всех доступных
                районах.
              </span>
            </span>
          </label>
        </fieldset>
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <div class="flex items-center gap-1">
              <Label for="order-region">Район</Label
              ><span aria-hidden="true" class="text-destructive">*</span>
            </div>
            <select
              id="order-region"
              v-model="form.districtId"
              class="native-select w-full"
              required
            >
              <option value="">Выберите район</option>
              <option
                v-for="district in districts"
                :key="district.id"
                :value="district.id"
              >
                {{ district.name }}
              </option>
            </select>
          </div>
          <div class="space-y-2">
            <div class="flex items-center gap-1">
              <Label for="client-phone">Телефон клиента</Label
              ><span aria-hidden="true" class="text-destructive">*</span>
            </div>
            <PhoneInput id="client-phone" v-model="form.clientPhone" required />
            <p class="text-xs text-muted-foreground">
              Номер виден водителю только после принятия.
            </p>
          </div>
        </div>
        <div class="space-y-2">
          <div class="flex items-center gap-1">
            <Label for="order-price">Стоимость, TMT</Label
            ><span aria-hidden="true" class="text-destructive">*</span>
          </div>
          <Input
            id="order-price"
            v-model="form.priceEstimated"
            type="number"
            min="0.01"
            step="0.01"
            required
            placeholder="Введите сумму"
          />
          <p class="text-xs text-muted-foreground">
            Сумма списывается с баланса при принятии заказа.
          </p>
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
      </div>
      <div class="order-form-map space-y-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="pickup">Откуда</Label
            ><Input
              id="pickup"
              v-model="form.pickupAddress"
              @input="edited.pickup = true"
              maxlength="300"
              placeholder="Улица, дом, ориентир"
            />
          </div>
          <div class="space-y-2">
            <Label for="dropoff">Куда</Label
            ><Input
              id="dropoff"
              v-model="form.dropoffAddress"
              @input="edited.dropoff = true"
              maxlength="300"
              placeholder="Адрес назначения"
            />
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            :variant="pickMode === 'pickup' ? 'default' : 'outline'"
            :aria-pressed="pickMode === 'pickup'"
            @click="pickMode = 'pickup'"
            >Откуда {{ point ? "✓" : "" }}</Button
          ><Button
            type="button"
            size="sm"
            :variant="pickMode === 'dropoff' ? 'default' : 'outline'"
            :aria-pressed="pickMode === 'dropoff'"
            @click="pickMode = 'dropoff'"
            >Куда {{ destination ? "✓" : "" }}</Button
          >
        </div>
        <p class="text-xs text-muted-foreground">
          Точки карты необязательны и не заменяют выбранный район.
        </p>
        <div
          v-if="!mapError"
          ref="mapElement"
          class="h-52 overflow-hidden rounded-lg border"
          aria-label="Карта уточнения точки подачи"
        />
        <p
          v-if="mapError"
          class="rounded-lg bg-muted p-3 text-sm text-muted-foreground"
        >
          {{ mapError }}
        </p>
        <p v-if="point" class="text-xs text-muted-foreground">
          Точка подачи выбрана
          <button
            type="button"
            class="ml-2 underline"
            @click="
              point = null;
              marker && map.geoObjects.remove(marker);
              marker = null;
            "
          >
            Убрать
          </button>
        </p>
        <p v-if="destination" class="text-xs text-muted-foreground">
          Место назначения выбрано
          <button
            type="button"
            class="ml-2 underline"
            @click="
              destination = null;
              destinationMarker && map.geoObjects.remove(destinationMarker);
              destinationMarker = null;
            "
          >
            Убрать
          </button>
        </p>
      </div>
    </div>
    <p v-if="error" role="alert" class="text-sm text-destructive">
      {{ error }}
    </p>
    <div
      class="sticky bottom-0 z-10 flex justify-end border-t bg-background py-3"
    >
      <Button
        type="submit"
        :disabled="
          pending ||
          !form.districtId ||
          !form.clientPhone.trim() ||
          !form.priceEstimated
        "
        >{{
          pending
            ? "Создаём…"
            : mode === "private"
              ? "Предложить на 20 секунд"
              : "Отправить водителям"
        }}</Button
      >
    </div>
  </form>
</template>
<style scoped>
.order-form-layout {
  display: grid;
  gap: 1.25rem;
}
@media (min-width: 900px) {
  .order-form-layout {
    grid-template-columns: minmax(19rem, 0.78fr) minmax(0, 1.22fr);
    align-items: start;
  }
  .order-form-primary {
    padding-right: 0.25rem;
  }
  .order-form-map {
    border-left: 1px solid var(--border);
    padding-left: 1.25rem;
  }
  .order-form-map :deep([aria-label="Карта уточнения точки подачи"]) {
    height: min(34rem, 62dvh);
    min-height: 25rem;
  }
}
@media (max-width: 899px) {
  .order-form-map :deep([aria-label="Карта уточнения точки подачи"]) {
    height: clamp(12rem, 42dvh, 20rem);
  }
}
</style>
