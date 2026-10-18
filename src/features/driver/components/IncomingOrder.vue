<script setup lang="ts">
import { ref } from "vue";
import { canFundOrder } from "@/shared/order-funding";
import { Button } from "@/shared/ui/button";
import { useDriver } from "../useDriver";
import OrderRoute from "./OrderRoute.vue";
import { money } from "../model";
defineProps<{ embedded?: boolean }>();
const { state, accept, dismissIncoming, declinePrivateOffer } = useDriver();
const eta = ref(10);
</script>
<template>
  <section
    v-if="state.incoming && !state.active"
    class="min-w-0 space-y-4"
    :class="embedded ? '' : 'panel'"
    aria-live="polite"
  >
    <header class="grid min-h-8 gap-1" :class="{ 'pr-9': embedded }">
      <h2 class="min-w-0 break-words text-xl font-semibold leading-snug">
        {{
          state.incoming.privateOfferExpiresAt
            ? "Личное предложение"
            : "Новый заказ"
        }}
      </h2>
      <p class="text-sm font-semibold text-primary">
        Заказ #{{ state.incoming.orderNumber }}
      </p>
      <p
        v-if="state.offerSeconds > 0"
        class="shrink-0 pt-0.5 text-sm font-semibold tabular-nums"
        role="timer"
        aria-label="Осталось времени на принятие"
      >
        {{ state.offerSeconds }} сек
      </p>
    </header>
    <p
      class="offer-price flex flex-wrap items-baseline gap-x-2 font-semibold leading-none tabular-nums"
    >
      <span class="min-w-0 break-words [overflow-wrap:anywhere]">{{
        money(state.incoming.priceEstimated)
          .slice(0, -4)
          .replace(/[\u00a0\u202f]/g, " ")
      }}</span>
      <span class="text-base font-medium text-muted-foreground">{{
        " TMT"
      }}</span>
    </p>
    <div
      class="offer-countdown h-1.5 overflow-hidden rounded-full bg-secondary"
      aria-hidden="true"
    >
      <div
        class="h-full origin-left bg-primary"
        :style="{ transform: `scaleX(${state.offerSeconds / 20})` }"
      />
    </div>
    <OrderRoute
      :pickup="state.incoming.pickupAddress"
      :destination="state.incoming.dropoffAddress"
      :note="state.incoming.note"
    />
    <p
      v-if="
        !canFundOrder(
          state.balance?.available ?? state.balance?.amount,
          state.incoming.priceEstimated,
        )
      "
      class="text-sm text-destructive"
    >
      Недостаточно средств.
      <template v-if="Number(state.incoming.priceEstimated) > 0"
        >Пополните баланс до {{ money(state.incoming.priceEstimated) }}, чтобы
        принять заказ.</template
      >
      <template v-else>Пополните баланс, чтобы принять заказ.</template>
    </p>
    <label class="grid gap-1.5 text-sm" for="incoming-eta"
      >Буду через<select
        id="incoming-eta"
        v-model="eta"
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
    >
    <div class="grid gap-1">
      <Button
        class="min-h-11 w-full"
        :disabled="
          state.busy ||
          !canFundOrder(
            state.balance?.available ?? state.balance?.amount,
            state.incoming.priceEstimated,
          )
        "
        @click="accept(state.incoming!.id, eta)"
        >Принять заказ</Button
      ><Button
        class="min-h-11 w-full whitespace-normal"
        variant="ghost"
        :disabled="state.busy"
        @click="
          state.incoming.privateOfferExpiresAt
            ? declinePrivateOffer()
            : dismissIncoming()
        "
        >{{
          state.incoming.privateOfferExpiresAt
            ? "Отказаться"
            : "Скрыть предложение"
        }}</Button
      >
    </div>
  </section>
</template>
<style scoped>
.offer-price {
  font-size: clamp(2.25rem, 10vw, 3rem);
}
.offer-countdown > div {
  transition: transform 250ms linear;
}
@media (prefers-reduced-motion: reduce) {
  .offer-countdown > div {
    transition: none;
  }
}
</style>
