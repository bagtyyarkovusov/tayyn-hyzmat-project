<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Phone,
  ArrowRight,
  Check,
  Ellipsis,
  Navigation,
} from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { useDriver } from "../useDriver";
import { money } from "../model";
import { tripNavigation, openTripNavigation } from "../navigation";

defineEmits<{ details: [] }>();
const { state, transition } = useDriver();
const navigation = computed(() => tripNavigation(state.active));
const navigationError = ref("");
async function navigate() {
  if (!navigation.value) return;
  navigationError.value = "";
  try {
    await openTripNavigation(navigation.value);
  } catch {
    navigationError.value = "Не удалось открыть карту. Повторите попытку.";
  }
}
const stages = ["Подача", "Ожидание", "В пути"];
const step = computed(() =>
  state.active?.status === "STARTED"
    ? 2
    : state.active?.status === "WAITING"
      ? 1
      : 0,
);
const action = computed(() =>
  step.value === 2
    ? { label: "Завершить поездку", transition: "complete" as const }
    : step.value === 1
      ? { label: "Начать поездку", transition: "start" as const }
      : { label: "Я на месте", transition: "waiting" as const },
);
</script>

<template>
  <section
    v-if="state.active"
    aria-label="Текущая поездка"
    class="trip-feed shrink-0 space-y-2 rounded-xl border bg-card p-3"
  >
    <div class="trip-heading flex items-center justify-between gap-3">
      <ol aria-label="Этапы поездки" class="flex min-w-0 gap-2 text-xs">
        <li
          v-for="(stage, index) in stages"
          :key="stage"
          :aria-current="index === step ? 'step' : undefined"
          :class="index === step ? 'font-semibold' : 'text-muted-foreground'"
          class="flex items-center gap-1"
        >
          <Check
            v-if="index < step"
            class="size-3 shrink-0"
            aria-hidden="true"
          />
          <ArrowRight
            v-else-if="index > 0"
            class="size-3 shrink-0"
            aria-hidden="true"
          />
          {{ stage }}
        </li>
      </ol>
      <Button
        variant="ghost"
        size="icon"
        class="-my-2 -mr-2 size-11 shrink-0 border-0 shadow-none focus-visible:ring-inset"
        aria-label="Поездка"
        title="Подробности поездки"
        @click="$emit('details')"
        ><Ellipsis class="size-5"
      /></Button>
    </div>
    <p class="text-sm font-semibold text-primary">
      Заказ #{{ state.active.orderNumber }}
    </p>
    <div class="trip-route flex items-start justify-between gap-3">
      <p class="min-w-0 flex-1 text-sm font-medium leading-snug">
        <span class="line-clamp-2 break-words">
          {{
            (step === 2 && state.active.dropoffAddress) ||
            state.active.pickupAddress ||
            "Подача уточняется по телефону"
          }}
        </span>
      </p>
      <p
        class="shrink-0 text-2xl font-semibold leading-none tabular-nums"
        aria-label="Цена поездки"
      >
        {{ money(state.active.priceEstimated) }}
      </p>
    </div>
    <div class="trip-actions flex gap-2">
      <Button
        v-if="state.active.clientPhone"
        variant="ghost"
        as-child
        class="min-h-11 shrink-0 px-3"
      >
        <a
          :href="`tel:${state.active.clientPhone}`"
          aria-label="Позвонить клиенту"
        >
          <Phone class="size-4" aria-hidden="true" />
          <span class="text-xs">Клиент</span>
        </a>
      </Button>
      <Button
        v-if="navigation"
        variant="ghost"
        size="icon"
        class="size-11 shrink-0 border-0 shadow-none focus-visible:ring-inset"
        :aria-label="navigation.label"
        :title="navigation.label"
        @click="navigate"
      >
        <Navigation class="size-5" aria-hidden="true" />
      </Button>
      <Button
        class="min-h-11 min-w-0 flex-1 whitespace-normal px-2 text-center leading-tight"
        :disabled="state.busy"
        :aria-busy="state.busy"
        @click="transition(action.transition)"
      >
        {{ state.busy ? "Сохраняем…" : action.label }}
      </Button>
    </div>
    <p v-if="navigationError" role="alert" class="text-xs text-destructive">
      {{ navigationError }}
    </p>
  </section>
</template>

<style scoped>
@media (orientation: portrait) and (max-height: 600px) {
  .trip-route > p:first-child {
    display: none;
  }
  .trip-route > p:last-child {
    font-size: 1.25rem;
  }
  .trip-feed {
    position: relative;
    padding: 0.5rem;
  }
  .trip-heading {
    float: left;
    min-height: 1.25rem;
    margin-right: 0.5rem;
  }
  .trip-heading button {
    position: absolute;
    right: 0.5rem;
    bottom: 0.5rem;
    margin: 0;
  }
  .trip-actions {
    padding-right: 2.75rem;
  }
}

@media (orientation: landscape) and (max-height: 500px) {
  .trip-feed {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.5rem;
    padding: 0;
    border: 0;
    background: transparent;
  }
  .trip-feed > * {
    margin: 0;
  }
  .trip-heading {
    order: 3;
  }
  .trip-heading ol,
  .trip-route > p:first-child {
    display: none;
  }
  .trip-heading button {
    margin: 0;
  }
  .trip-route {
    order: 1;
  }
  .trip-route > p:last-child {
    font-size: 1.25rem;
  }
  .trip-actions {
    order: 2;
  }
}
</style>
