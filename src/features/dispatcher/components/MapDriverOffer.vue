<script setup lang="ts">
import { ref } from "vue";
import { adminApi } from "@/shared/api";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import type { Order, Page } from "../domain";
import { useResource } from "../useResource";
import CreateOrderForm from "./CreateOrderForm.vue";
import PrivateOfferForm from "./PrivateOfferForm.vue";
defineProps<{ driverId: string }>();
const emit = defineEmits<{ offered: [] }>();
const mode = ref("existing"),
  orderId = ref("");
const { data, loading, error } = useResource(
  async () =>
    (
      await adminApi.get<Page<Order>>("/admin/orders", {
        params: { status: "active", limit: 100 },
      })
    ).data.items,
  [] as Order[],
  [
    "order:new",
    "order:accepted",
    "order:cancelled",
    "order:private-offer",
    "order:updated",
    "order:private-offer-ended",
  ],
);
</script>
<template>
  <div class="space-y-4">
    <div class="flex flex-wrap gap-2">
      <Button
        type="button"
        :variant="mode === 'existing' ? 'default' : 'outline'"
        :aria-pressed="mode === 'existing'"
        @click="mode = 'existing'"
        >Существующий заказ</Button
      >
      <Button
        type="button"
        :variant="mode === 'new' ? 'default' : 'outline'"
        :aria-pressed="mode === 'new'"
        @click="mode = 'new'"
        >Новый заказ</Button
      >
    </div>
    <CreateOrderForm
      v-if="mode === 'new'"
      :initial-driver-id="driverId"
      @created="emit('offered')"
    />
    <div v-else class="space-y-4">
      <div class="space-y-2">
        <Label for="map-offer-order">Заказ</Label>
        <select
          id="map-offer-order"
          v-model="orderId"
          class="native-select w-full"
          :disabled="loading"
        >
          <option value="">
            {{ loading ? "Загружаем заказы…" : "Выберите заказ" }}
          </option>
          <option
            v-for="order in data.filter(
              (order) => order.status === 'NEW' && !order.privateOfferDriverId,
            )"
            :key="order.id"
            :value="order.id"
          >
            #{{ order.orderNumber }} · {{ order.district?.name }} ·
            {{ order.pickupAddress || "Без адреса" }}
          </option>
        </select>
        <p v-if="error" role="alert" class="text-sm text-destructive">
          {{ error }}
        </p>
        <p
          v-else-if="
            !loading &&
            !data.some(
              (order) => order.status === 'NEW' && !order.privateOfferDriverId,
            )
          "
          class="text-sm text-muted-foreground"
        >
          Свободных заказов нет. Создайте новый.
        </p>
      </div>
      <PrivateOfferForm
        v-if="orderId"
        :key="orderId"
        :order-id="orderId"
        :price-estimated="
          data.find((order) => order.id === orderId)?.priceEstimated
        "
        :initial-driver-id="driverId"
        @offered="emit('offered')"
      />
    </div>
  </div>
</template>
