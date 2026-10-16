<script setup lang="ts">
import { computed, watch } from "vue";
import { canFundOrder } from "@/shared/order-funding";
import { money } from "../domain";
import { Label } from "@/shared/ui/label";
import { canOfferToDriver } from "../private-offers";
import { useMonitoringFleet } from "../useMonitoringFleet";
const selected = defineModel<string>({ required: true });
const props = defineProps<{
  id: string;
  disabled?: boolean;
  priceEstimated?: number | string | null;
}>();
const { drivers: data, loading, error, now, load } = useMonitoringFleet();
const eligible = computed(() =>
  data.value.filter((driver) => canOfferToDriver(driver, now.value)),
);
watch([selected, eligible, loading, () => props.priceEstimated], () => {
  if (
    !loading.value &&
    selected.value &&
    !eligible.value.some(
      (driver) =>
        driver.id === selected.value &&
        canFundOrder(driver.user.balance?.amount, props.priceEstimated),
    )
  )
    selected.value = "";
});
</script>
<template>
  <div class="space-y-2">
    <div class="flex items-center gap-1">
      <Label :for="id">Водитель</Label>
      <span aria-hidden="true" class="text-destructive">*</span>
    </div>
    <select
      :id="id"
      v-model="selected"
      class="native-select w-full"
      required
      aria-required="true"
      :disabled="disabled || loading"
    >
      <option value="">
        {{ loading ? "Загружаем водителей…" : "Выберите водителя" }}
      </option>
      <option
        v-for="driver in eligible"
        :key="driver.id"
        :value="driver.id"
        :disabled="!canFundOrder(driver.user.balance?.amount, priceEstimated)"
      >
        {{ driver.user.fullName }} ·
        {{ driver.currentVehicle?.plateNumber || "Без машины" }} ·
        {{ driver.district?.name || "Без района" }} ·
        {{ money(driver.user.balance?.amount)
        }}{{
          !canFundOrder(driver.user.balance?.amount, priceEstimated)
            ? " · недостаточно средств"
            : ""
        }}
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
