<script setup lang="ts">
import { computed } from "vue";
import { Phone, ArrowRight, Check, Ellipsis } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { formatPhone } from "@/shared/phone";
import { useDriver } from "../useDriver";
import { money } from "../model";

defineEmits<{ details: [] }>();
const { state, transition } = useDriver();
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
    <div class="flex items-center justify-between gap-3">
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
        class="-my-2 -mr-2 size-11 shrink-0"
        aria-label="Поездка"
        title="Подробности поездки"
        @click="$emit('details')"
        ><Ellipsis class="size-5"
      /></Button>
    </div>
    <div class="flex items-start justify-between gap-3">
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
    <div class="flex gap-2">
      <Button
        v-if="state.active.clientPhone"
        variant="outline"
        as-child
        class="min-h-11 shrink-0 px-3"
      >
        <a
          :href="`tel:${state.active.clientPhone}`"
          :aria-label="`Позвонить клиенту ${formatPhone(state.active.clientPhone)}`"
        >
          <Phone class="size-4" aria-hidden="true" />
          <span class="text-xs">Клиент</span>
        </a>
      </Button>
      <Button
        class="min-h-11 min-w-0 flex-1"
        :disabled="state.busy"
        :aria-busy="state.busy"
        @click="transition(action.transition)"
      >
        {{ state.busy ? "Сохраняем…" : action.label }}
      </Button>
    </div>
  </section>
</template>
