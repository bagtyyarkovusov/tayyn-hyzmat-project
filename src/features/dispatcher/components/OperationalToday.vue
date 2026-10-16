<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { adminApi } from "@/shared/api";
import { useResource } from "../useResource";
import PageState from "./PageState.vue";

interface TodayOverview {
  asOf: string;
  date: string;
  timeZone: string;
  cohort: {
    created: number;
    completed: number;
    cancelled: number;
    unfinished: number;
    terminal: number;
    completionRate: number | null;
    cancellationRate: number | null;
  };
  acceptance: {
    samples: number;
    missing: number;
    invalid: number;
    medianSeconds: number | null;
    p90Seconds: number | null;
  };
  waiting: {
    publicOrders: number;
    privateReservations: number;
    oldestSeconds: number | null;
  };
}
const { data, loading, error, load } = useResource<TodayOverview | null>(
  async () => (await adminApi.get<TodayOverview>("/admin/overview/today")).data,
  null,
  [
    "order:new",
    "order:updated",
    "order:accepted",
    "order:completed",
    "order:cancelled",
  ],
);
function duration(seconds: number | null) {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)} с`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин`;
  return `${Math.floor(seconds / 3600)} ч ${Math.floor((seconds % 3600) / 60)} мин`;
}
function rate(value: number | null) {
  return value === null
    ? "—"
    : `${(value * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;
}
function refreshVisible() {
  if (document.visibilityState === "visible") void load();
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  timer = setInterval(refreshVisible, 30_000);
  document.addEventListener("visibilitychange", refreshVisible);
});
onUnmounted(() => {
  clearInterval(timer);
  document.removeEventListener("visibilitychange", refreshVisible);
});
</script>
<template>
  <section aria-label="Оперативные показатели" class="border-t pt-4">
    <div
      class="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
    >
      <h2 class="text-sm font-semibold">Сегодня</h2>
      <p class="text-xs text-muted-foreground">
        {{ data?.date }} · Ашхабад, UTC+5
      </p>
    </div>
    <PageState :loading="loading && !data" :error="error" @retry="load" />
    <div v-if="data && !error" class="space-y-4">
      <dl class="grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-4">
        <div>
          <dt class="text-xs text-muted-foreground">Создано сегодня</dt>
          <dd class="mt-1 font-semibold tabular-nums">
            {{ data.cohort.created }}
          </dd>
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">Завершено</dt>
          <dd class="mt-1 font-semibold tabular-nums">
            {{ data.cohort.completed }}
            <span class="text-xs font-normal text-muted-foreground"
              >· {{ rate(data.cohort.completionRate) }}</span
            >
          </dd>
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">Отменено</dt>
          <dd class="mt-1 font-semibold tabular-nums">
            {{ data.cohort.cancelled }}
            <span class="text-xs font-normal text-muted-foreground"
              >· {{ rate(data.cohort.cancellationRate) }}</span
            >
          </dd>
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">Ещё в работе</dt>
          <dd class="mt-1 font-semibold tabular-nums">
            {{ data.cohort.unfinished }}
          </dd>
        </div>
      </dl>
      <p class="text-xs text-muted-foreground">
        Только заказы, созданные сегодня. Доли — из
        {{ data.cohort.terminal }} завершённых и отменённых.
      </p>
      <div class="grid gap-4 border-t pt-3 sm:grid-cols-2">
        <div>
          <h3 class="text-xs text-muted-foreground">Время до принятия</h3>
          <p class="mt-1 text-sm tabular-nums">
            <span class="font-semibold">{{
              duration(data.acceptance.medianSeconds)
            }}</span>
            медиана
            <span class="mx-1 text-muted-foreground">·</span>
            <span class="font-semibold">{{
              duration(data.acceptance.p90Seconds)
            }}</span>
            p90
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ data.acceptance.samples }} замеров, включая принятые, затем
            отменённые. Без времени принятия: {{ data.acceptance.missing
            }}<template v-if="data.acceptance.invalid"
              >; некорректные интервалы: {{ data.acceptance.invalid }}</template
            >.
          </p>
        </div>
        <div>
          <h3 class="text-xs text-muted-foreground">
            Сейчас ждут принятия · за все дни
          </h3>
          <p class="mt-1 text-sm tabular-nums">
            <span class="font-semibold">{{ data.waiting.publicOrders }}</span> в
            общей очереди
            <span class="mx-1 text-muted-foreground">·</span>
            дольше всех
            <span class="font-semibold">{{
              duration(data.waiting.oldestSeconds)
            }}</span>
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            Приватных предложений: {{ data.waiting.privateReservations }}. Общая
            очередь учитывает период доступа только своему району.
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
