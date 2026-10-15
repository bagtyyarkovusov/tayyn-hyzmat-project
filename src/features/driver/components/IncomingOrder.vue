<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/shared/ui/button";
import { useDriver } from "../useDriver";
import { money } from "../model";
const { state, countdown, accept, dismissIncoming } = useDriver();
const eta = ref(10);
</script>
<template>
  <section
    v-if="state.incoming && !state.active"
    class="panel space-y-3 border-primary/40"
    aria-live="polite"
  >
    <div class="flex justify-between gap-3">
      <h2 class="font-semibold">Новый заказ</h2>
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
    <p class="muted text-sm">
      Автоматическое принятие через {{ Math.floor(countdown / 60) }}:{{
        String(countdown % 60).padStart(2, "0")
      }}
      с прибытием за 5 мин. Скрытие предложения отменит автоматическое принятие.
    </p>
    <p class="muted text-xs">
      При принятии указанная сумма списывается с тестового баланса. Телефон
      откроется после принятия.
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
      ><Button variant="outline" :disabled="state.busy" @click="dismissIncoming"
        >Скрыть предложение</Button
      >
    </div>
  </section>
</template>
