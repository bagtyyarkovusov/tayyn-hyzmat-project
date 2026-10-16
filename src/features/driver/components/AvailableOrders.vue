<script setup lang="ts">
import { ref, watch } from "vue";
import { canFundOrder } from "@/shared/order-funding";
import { MapPin, ArrowDown, RefreshCw } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { driverApi, errorMessage } from "@/shared/api";
import { driverSession } from "@/features/auth/session";
import { useDriver } from "../useDriver";
import { money, type Order } from "../model";
import { onUnmounted } from "vue";
const props = defineProps<{ districtId: string; districtName: string }>();
const { state, accept } = useDriver();
const orders = ref<Order[]>([]),
  loading = ref(false),
  error = ref("");
const loaded = ref(false);
const eta = ref<Record<string, number>>({});
let request = 0;
async function load() {
  const id = ++request;
  loading.value = true;
  error.value = "";
  try {
    const { data } = await driverApi.get<Order[]>("/orders/available", {
      params: { districtId: props.districtId },
    });
    if (id === request) {
      orders.value = data;
      loaded.value = true;
    }
  } catch (e) {
    if (id === request) error.value = errorMessage(e);
  } finally {
    if (id === request) loading.value = false;
  }
}
async function claim(id: string) {
  await accept(id, eta.value[id] || 10);
  if (!state.active) await load();
}
watch(
  () => props.districtId,
  () => {
    loaded.value = false;
    orders.value = [];
    void load();
  },
  { immediate: true },
);
const off = ["order:new", "order:taken", "districts:stats", "connect"].map(
  (event) => driverSession.on(event, () => void load()),
);
const resume = () => {
  if (!document.hidden) void load();
};
document.addEventListener("visibilitychange", resume);
onUnmounted(() => {
  document.removeEventListener("visibilitychange", resume);
  request++;
  off.forEach((fn) => fn());
});
</script>
<template>
  <section class="space-y-4" aria-label="Доступные заказы" :aria-busy="loading">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">{{ districtName }}</h2>
        <p class="muted text-sm">Доступные заказы</p>
      </div>
      <Button
        variant="outline"
        size="icon"
        aria-label="Обновить заказы"
        :disabled="loading"
        @click="load"
        ><RefreshCw class="size-4" :class="{ 'animate-spin': loading }"
      /></Button>
    </div>
    <p
      v-if="error || state.error"
      role="alert"
      class="text-sm text-destructive"
    >
      {{ error || state.error }}
    </p>
    <p v-if="loading && !loaded" role="status" class="muted py-6 text-center">
      Загружаем заказы…
    </p>
    <p v-else-if="!orders.length" class="muted py-8 text-center">
      Сейчас нет свободных заказов. Новые появятся автоматически.
    </p>
    <article
      v-for="order in orders"
      v-else
      :key="order.id"
      class="space-y-4 border-t pt-5"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 space-y-2">
          <p class="flex items-start gap-2 font-medium">
            <MapPin class="mt-0.5 size-4 shrink-0 text-primary" /><span
              class="break-words"
              >{{
                order.pickupAddress || "Подача уточняется по телефону"
              }}</span
            >
          </p>
          <p
            v-if="order.dropoffAddress"
            class="flex items-start gap-2 text-sm text-muted-foreground"
          >
            <ArrowDown class="size-4 shrink-0" /><span class="break-words">{{
              order.dropoffAddress
            }}</span>
          </p>
        </div>
        <span class="shrink-0 font-semibold tabular-nums">{{
          money(order.priceEstimated)
        }}</span>
      </div>
      <p v-if="order.note" class="muted text-sm break-words">
        {{ order.note }}
      </p>
      <p class="muted text-xs">
        Телефон пассажира откроется после принятия. При принятии списывается
        указанная сумма с баланса.
      </p>
      <div class="flex flex-wrap items-end gap-3">
        <label class="grid gap-1 text-sm" :for="`eta-${order.id}`"
          >Буду через<select
            :id="`eta-${order.id}`"
            v-model="eta[order.id]"
            class="native-select min-h-11"
            :disabled="state.busy"
          >
            <option :value="undefined" disabled>10 мин</option>
            <option
              v-for="minutes in [5, 10, 15, 20]"
              :key="minutes"
              :value="minutes"
            >
              {{ minutes }} мин
            </option>
          </select></label
        ><Button
          class="flex-1"
          :disabled="
            state.busy ||
            !!state.active ||
            !canFundOrder(state.balance?.amount, order.priceEstimated) ||
            !state.gpsReady ||
            !state.profile?.isOnline
          "
          @click="claim(order.id)"
          >Принять заказ</Button
        >
      </div>
      <p
        v-if="!canFundOrder(state.balance?.amount, order.priceEstimated)"
        class="text-sm text-destructive"
      >
        Недостаточно средств.
        <template v-if="Number(order.priceEstimated) > 0"
          >Пополните баланс до {{ money(order.priceEstimated) }}, чтобы принять
          заказ.</template
        >
        <template v-else>Пополните баланс, чтобы принять заказ.</template>
      </p>
      <p v-if="state.active" class="muted text-xs">
        Сначала завершите текущую поездку.
      </p>
    </article>
  </section>
</template>
