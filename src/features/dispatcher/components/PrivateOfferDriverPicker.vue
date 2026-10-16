<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { adminApi } from "@/shared/api";
import { Label } from "@/shared/ui/label";
import { canOfferToDriver } from "../private-offers";
import { useResource } from "../useResource";
import type { Driver, Page } from "../domain";
const selected = defineModel<string>({ required: true });
defineProps<{ id: string; disabled?: boolean }>();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
const { data, loading, error, load } = useResource(
  async () =>
    (
      await adminApi.get<Page<Driver>>("/admin/drivers", {
        params: { status: "APPROVED", limit: 100 },
      })
    ).data.items,
  [] as Driver[],
  [
    "driver:status",
    "driver:location",
    "order:accepted",
    "order:completed",
    "order:cancelled",
    "order:private-offer",
    "order:updated",
    "order:private-offer-ended",
  ],
);
const eligible = computed(() =>
  data.value.filter((driver) => canOfferToDriver(driver, now.value)),
);
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer);
});
</script>
<template>
  <div class="space-y-2">
    <Label :for="id">Водитель</Label>
    <select
      :id="id"
      v-model="selected"
      class="native-select w-full"
      required
      :disabled="disabled || loading"
    >
      <option value="">
        {{ loading ? "Загружаем водителей…" : "Выберите водителя" }}
      </option>
      <option v-for="driver in eligible" :key="driver.id" :value="driver.id">
        {{ driver.user.fullName }} ·
        {{ driver.currentVehicle?.plateNumber || "Без машины" }} ·
        {{ driver.district?.name || "Без района" }}
      </option>
    </select>
    <p v-if="error" role="alert" class="text-sm text-destructive">
      {{ error }}
      <button type="button" class="underline underline-offset-4" @click="load">
        Повторить
      </button>
    </p>
    <p
      v-else-if="!loading && !eligible.length"
      class="text-sm text-muted-foreground"
    >
      Нет свободных водителей на линии со свежим GPS.
    </p>
    <p v-else class="text-xs text-muted-foreground">
      Свободные водители из всех районов. На подтверждение — 20 секунд; затем
      заказ появится в своём районе.
    </p>
  </div>
</template>
