<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { canFundOrder } from "@/shared/order-funding";
import OrderRoute from "./OrderRoute.vue";
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
      // The driver may claim any public order city-wide. The selected region
      // is only a presentation priority; the API still re-checks eligibility
      // and performs the atomic claim at acceptance time.
      params: { districtId: props.districtId, scope: "all" },
    });
    if (id === request) {
      orders.value = data;
      for (const order of data) eta.value[order.id] ??= 10;
      loaded.value = true;
    }
  } catch (e) {
    if (id === request) error.value = errorMessage(e);
  } finally {
    if (id === request) loading.value = false;
  }
}
const sortedOrders = computed(() =>
  [...orders.value].sort((a, b) => {
    const aLocal = a.districtId === props.districtId ? 0 : 1;
    const bLocal = b.districtId === props.districtId ? 0 : 1;
    if (aLocal !== bLocal) return aLocal - bLocal;
    const aNumber = Number(a.orderNumber);
    const bNumber = Number(b.orderNumber);
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber))
      return aNumber - bNumber;
    return a.createdAt.localeCompare(b.createdAt);
  }),
);
const localOrders = computed(() =>
  sortedOrders.value.filter((order) => order.districtId === props.districtId),
);
const otherOrders = computed(() =>
  sortedOrders.value.filter((order) => order.districtId !== props.districtId),
);
const groups = computed(() => [
  { id: "selected", name: props.districtName, orders: localOrders.value },
  { id: "other", name: "Другие районы", orders: otherOrders.value },
]);
function orderNumber(order: Order) {
  return `Заказ #${order.orderNumber}`;
}
function regionName(order: Order) {
  return order.district?.name || "Другой район";
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
const off = ["order:new", "order:available", "districts:stats", "connect"].map(
  (event) => driverSession.on(event, () => void load()),
);
for (const event of ["order:taken", "order:cancelled"])
  off.push(
    driverSession.on(event, (payload) => {
      const ended = payload as { orderId?: string; id?: string };
      const orderId = ended.orderId ?? ended.id;
      // Remove the closed order before the reconciliation request finishes.
      // Incrementing request also prevents an older in-flight list restoring it.
      request++;
      orders.value = orders.value.filter((order) => order.id !== orderId);
      void load();
    }),
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
  <section
    class="queue-list min-h-0 overflow-y-auto overscroll-contain space-y-3"
    aria-label="Доступные заказы"
    :aria-busy="loading"
    tabindex="0"
  >
    <p
      v-if="error || state.error"
      role="alert"
      class="text-sm text-destructive"
    >
      {{ error || state.error }}
      <Button
        variant="link"
        class="min-h-11 px-1"
        :disabled="loading"
        @click="load"
        >Повторить</Button
      >
    </p>
    <p v-if="loading && !loaded" role="status" class="muted py-6 text-center">
      Загружаем заказы…
    </p>
    <p v-else-if="!orders.length" class="muted py-8 text-center">
      Сейчас нет свободных заказов.
    </p>
    <template v-else v-for="group in groups" :key="group.id">
      <section
        v-if="group.orders.length"
        :aria-label="group.name"
        class="space-y-1"
      >
        <h3 class="sticky top-0 z-10 bg-background py-2 text-sm font-semibold">
          {{ group.name }}
        </h3>
        <article
          v-for="order in group.orders"
          :key="order.id"
          class="space-y-3 border-t py-3"
          :data-region="regionName(order)"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 space-y-2">
              <p class="flex flex-wrap items-start gap-x-2 gap-y-1 font-medium">
                <span class="shrink-0 text-sm font-semibold text-primary">{{
                  orderNumber(order)
                }}</span>
                <span
                  class="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
                  >{{ regionName(order) }}</span
                >
              </p>
            </div>
            <span
              class="shrink-0 text-3xl font-semibold leading-tight tabular-nums"
              >{{ money(order.priceEstimated) }}</span
            >
          </div>
          <OrderRoute
            :pickup="order.pickupAddress"
            :destination="order.dropoffAddress"
            :note="order.note"
          />
          <div
            class="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-2 bg-background pb-1"
          >
            <label class="grid gap-1 text-sm" :for="`eta-${order.id}`"
              >Буду через<select
                :id="`eta-${order.id}`"
                v-model="eta[order.id]"
                class="native-select min-h-11"
                :disabled="state.busy"
              >
                <option
                  v-for="minutes in [5, 10, 15, 20]"
                  :key="minutes"
                  :value="minutes"
                >
                  {{ minutes }} мин
                </option>
              </select></label
            ><Button
              class="min-h-11"
              :disabled="
                state.busy ||
                !!state.active ||
                !canFundOrder(
                  state.balance?.available ?? state.balance?.amount,
                  order.priceEstimated,
                ) ||
                !state.gpsReady ||
                !state.profile?.isOnline
              "
              @click="claim(order.id)"
              >Принять заказ</Button
            >
          </div>
          <p
            v-if="
              !canFundOrder(
                state.balance?.available ?? state.balance?.amount,
                order.priceEstimated,
              )
            "
            class="text-sm text-destructive"
          >
            Недостаточно средств.
            <template v-if="Number(order.priceEstimated) > 0"
              >Пополните баланс до {{ money(order.priceEstimated) }}, чтобы
              принять заказ.</template
            >
            <template v-else>Пополните баланс, чтобы принять заказ.</template>
          </p>
          <p v-if="state.active" class="muted text-xs">
            Сначала завершите текущую поездку.
          </p>
        </article>
      </section>
    </template>
    <p
      v-if="!localOrders.length && otherOrders.length"
      class="muted border-t py-2 text-xs"
    >
      В выбранном районе сейчас нет заказов.
    </p>
  </section>
</template>
