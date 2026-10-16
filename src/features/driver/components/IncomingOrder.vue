<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/shared/ui/button";
import { useDriver } from "../useDriver";
import { money } from "../model";
const { state, accept, dismissIncoming, declinePrivateOffer } = useDriver();
const eta = ref(10);
</script>
<template>
  <section
    v-if="state.incoming && !state.active"
    class="panel space-y-3 border-primary/40"
    aria-live="polite"
  >
    <div class="flex justify-between gap-3">
      <h2 class="font-semibold">
        {{
          state.incoming.privateOfferExpiresAt
            ? "Личное предложение"
            : "Новый заказ"
        }}
      </h2>
      <span class="shrink-0 font-semibold tabular-nums">{{
        money(state.incoming.priceEstimated)
      }}</span>
    </div>
    <p class="break-words font-medium">
      {{ state.incoming.pickupAddress || "Подача уточняется по телефону" }}
    </p>
    <p v-if="state.incoming.dropoffAddress" class="muted text-sm break-words">
      {{ state.incoming.dropoffAddress }}
    </p>
    <p
      v-if="state.incoming.privateOfferExpiresAt"
      class="text-lg font-semibold tabular-nums"
      role="timer"
      aria-label="Осталось времени на принятие"
    >
      {{ state.offerSeconds }} сек
    </p>
    <p class="muted text-sm">
      Заказ принимается только после нажатия «Принять заказ».
    </p>
    <p class="muted text-xs">
      При принятии указанная сумма списывается с баланса. Телефон откроется
      после принятия.
    </p>
    <label class="grid gap-1 text-sm" for="incoming-eta"
      >Буду через<select
        id="incoming-eta"
        v-model="eta"
        class="native-select min-h-11"
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
    <div class="flex flex-wrap gap-2">
      <Button :disabled="state.busy" @click="accept(state.incoming!.id, eta)"
        >Принять заказ</Button
      ><Button
        variant="outline"
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
