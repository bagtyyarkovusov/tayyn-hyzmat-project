<script setup lang="ts">
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
</script>
<template>
  <section
    v-if="data.total || error"
    aria-label="Отмены требуют решения"
    class="border-b bg-secondary px-4 py-3 text-sm"
  >
    <p v-if="error" role="alert">
      {{ error }}
      <button class="min-h-11 underline" @click="load">Повторить</button>
    </p>
    <template v-else>
      <h2 class="font-semibold">Отмены требуют решения · {{ data.total }}</h2>
      <ul class="mt-1 space-y-1">
        <li
          v-for="order in data.items"
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
    </template>
  </section>
</template>
