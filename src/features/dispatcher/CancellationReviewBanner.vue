<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { adminSession } from "@/features/auth/session";
import { createAdminChatSound } from "./adminChatSound";
import { useResource } from "./useResource";
import { adminApi } from "@/shared/api";
import type { Order, Page } from "./domain";
const { data, error, load } = useResource(
  async () =>
    (
      await adminApi.get<Page<Order>>("/admin/orders/cancellation-review", {
        params: { limit: 20 },
      })
    ).data,
  { items: [], total: 0, page: 1, limit: 20 },
  ["order:cancelled", "order:reoffered", "order:cancellation-resolved"],
);
const sound = createAdminChatSound(
  () => adminSession.state.user?.id ?? null,
  "cancellation",
);
const pending = new Map<string, string>();
const seen = new Set<string>();
const stops: (() => void)[] = [];
let mounted = false;
onMounted(() => {
  mounted = true;
  stops.push(
    adminSession.on("order:cancelled", (order: Order) => {
      const id = order?.notificationEventId;
      if (!order?.cancellationReviewRequired || !id || seen.has(id)) return;
      seen.add(id);
      if (seen.size > 500) seen.delete(seen.values().next().value as string);
      pending.set(order.id, id);
      void sound.play(id, () => mounted && pending.get(order.id) === id);
    }),
  );
  for (const event of ["order:reoffered", "order:cancellation-resolved"]) {
    stops.push(
      adminSession.on(
        event,
        (order: {
          id?: string;
          orderId?: string;
          resolvedNotificationEventId?: string;
        }) => {
          const orderId = order?.id ?? order?.orderId;
          const id = orderId ? pending.get(orderId) : undefined;
          if (id && orderId && order.resolvedNotificationEventId === id) {
            pending.delete(orderId);
            sound.cancel(id);
          }
        },
      ),
    );
  }
});
onUnmounted(() => {
  mounted = false;
  stops.forEach((stop) => stop());
  sound.dispose();
});
</script>
<template>
  <section
    v-if="data.total || error"
    aria-label="Отмены требуют решения"
    class="flex max-h-[20dvh] min-w-0 flex-col bg-secondary px-4 py-3 text-sm md:max-h-[40dvh]"
  >
    <p v-if="error" role="alert">
      {{ error }}
      <button class="min-h-11 underline" @click="load">Повторить</button>
    </p>
    <template v-else>
      <h2 class="shrink-0 font-semibold">
        Отмены требуют решения · {{ data.total }}
      </h2>
      <ul class="mt-1 min-h-0 space-y-1 overflow-y-auto overscroll-contain">
        <li
          v-for="order in data.items.slice(0, 3)"
          :key="order.id"
          class="flex flex-wrap items-center gap-x-2"
        >
          <RouterLink
            class="min-h-11 content-center font-semibold underline underline-offset-4"
            :to="{
              path: '/adminOrders',
              query: { status: 'cancelled', orderNumber: order.orderNumber },
            }"
            >Заказ #{{ order.orderNumber }}</RouterLink
          >
          <RouterLink
            v-if="order.driver"
            class="min-h-11 content-center underline underline-offset-4"
            :to="`/adminDrivers/${order.driver.id}`"
            >{{ order.driver.user.fullName }}</RouterLink
          >
        </li>
      </ul>
      <RouterLink
        v-if="data.total > 3"
        :to="{ path: '/adminOrders', query: { status: 'cancelled' } }"
        class="inline-flex min-h-11 shrink-0 items-center font-semibold underline underline-offset-4"
        >Все отмены · {{ data.total }}</RouterLink
      >
    </template>
  </section>
</template>
