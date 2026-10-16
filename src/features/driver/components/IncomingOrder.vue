<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/shared/ui/button";
import { useDriver } from "../useDriver";
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
      <h2 class="min-w-0 break-words text-lg font-semibold leading-snug">
        {{
          state.incoming.privateOfferExpiresAt
            ? "Личное предложение"
            : "Новый заказ"
        }}
      </h2>
      <p
        v-if="state.incoming.privateOfferExpiresAt"
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
      <span>{{ money(state.incoming.priceEstimated).slice(0, -4) }}</span>
      <span class="text-base font-medium text-muted-foreground">TMT</span>
    </p>
    <div class="min-w-0 space-y-2">
      <p class="break-words font-medium [overflow-wrap:anywhere]">
        {{ state.incoming.pickupAddress || "Подача уточняется по телефону" }}
      </p>
      <p
        v-if="state.incoming.dropoffAddress"
        class="muted text-sm break-words [overflow-wrap:anywhere]"
      >
        {{ state.incoming.dropoffAddress }}
      </p>
    </div>
    <p class="muted text-sm leading-relaxed">
      При принятии спишется {{ money(state.incoming.priceEstimated) }} с
      баланса. Телефон клиента откроется после принятия.
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
        :disabled="state.busy"
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
  font-size: clamp(1.75rem, 8vw, 2.25rem);
}
</style>
