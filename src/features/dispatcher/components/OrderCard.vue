<script setup lang="ts">
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { MapPin, ArrowDown, Phone } from "lucide-vue-next";
import { date, money, statusLabel, type Order } from "../domain";
defineProps<{ order: Order; cancellable?: boolean; offerable?: boolean }>();
defineEmits<{ cancel: [Order]; offer: [Order]; resolve: [Order] }>();
const ageLabel = (seconds?: number | null) => {
  if (seconds == null) return "";
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}ч ${minutes % 60}м` : `${minutes}м`;
};
</script>
<template>
  <article class="rounded-xl border bg-card p-4 sm:p-5">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <Badge variant="secondary">{{ statusLabel(order.status) }}</Badge
        ><span class="text-xs text-muted-foreground"
          >#{{ order.id.slice(0, 8) }}</span
        >
      </div>
      <strong class="tabular-nums">{{
        money(order.priceFinal ?? order.priceEstimated)
      }}</strong>
    </div>
    <div class="my-4 grid grid-cols-[20px_1fr] items-center gap-x-2 gap-y-1">
      <MapPin class="size-4 text-primary" />
      <p class="font-medium">
        {{ order.pickupAddress || "Подача уточняется по телефону" }}
      </p>
      <ArrowDown class="size-4 text-muted-foreground" />
      <p class="text-sm text-muted-foreground">
        {{ order.dropoffAddress || "Адрес назначения не указан" }}
      </p>
    </div>
    <div
      class="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground"
    >
      <div class="space-y-1">
        <p>
          {{ order.district?.name || "Район не указан" }} ·
          {{ date(order.createdAt) }}
        </p>
        <p v-if="order.privateOfferDriverId && order.privateOfferExpiresAt">
          Личное предложение до
          {{
            new Date(order.privateOfferExpiresAt).toLocaleTimeString("ru-RU")
          }}
        </p>
        <p v-if="order.driver">{{ order.driver.user.fullName }}</p>
        <a
          v-if="order.clientPhone"
          :href="`tel:${order.clientPhone}`"
          class="flex items-center gap-1 text-foreground"
          ><Phone class="size-3" />{{ order.clientPhone }}</a
        >
        <p v-if="order.note">{{ order.note }}</p>
        <p
          v-if="order.status === 'STARTED'"
          class="font-medium"
          :class="
            order.needsCompletion ? 'text-destructive' : 'text-muted-foreground'
          "
        >
          {{ order.needsCompletion ? "Требует завершения" : "В пути" }} ·
          {{ ageLabel(order.startedAgeSeconds) }}
        </p>
      </div>
      <Button
        v-if="
          offerable && order.status === 'NEW' && !order.privateOfferDriverId
        "
        variant="outline"
        size="sm"
        @click="$emit('offer', order)"
        >Предложить водителю</Button
      >
      <Button
        v-if="cancellable && !['CANCELLED', 'COMPLETED'].includes(order.status)"
        variant="outline"
        size="sm"
        @click="$emit('cancel', order)"
        >Отменить заказ</Button
      >
      <Button
        v-if="order.status === 'STARTED' && order.needsCompletion"
        variant="destructive"
        size="sm"
        @click="$emit('resolve', order)"
        >Завершить вручную</Button
      >
    </div>
  </article>
</template>
