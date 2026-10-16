<script setup lang="ts">
import { RouterLink } from "vue-router";
import { ArrowUpRight, Plus } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { adminApi } from "@/shared/api";
import { useResource } from "./useResource";
import { money, type District } from "./domain";
interface Overview {
  totalDrivers: number;
  onlineDrivers: number;
  pendingDrivers: number;
  activeOrders: number;
  completedTrips: number;
  pricedCompletedTrips: number;
  completedTripValue: string;
  averageCompletedTripValue: string;
}
import PageState from "./components/PageState.vue";
import OperationalToday from "./components/OperationalToday.vue";
const { data, loading, error, load } = useResource(
  async () => {
    const [regions, overview] = await Promise.all([
      adminApi.get<District[]>("/districts"),
      adminApi.get<Overview>("/admin/overview"),
    ]);
    return { regions: regions.data, ...overview.data };
  },
  {
    regions: [] as District[],
    totalDrivers: 0,
    onlineDrivers: 0,
    pendingDrivers: 0,
    activeOrders: 0,
    completedTrips: 0,
    pricedCompletedTrips: 0,
    completedTripValue: "0.00",
    averageCompletedTripValue: "0.00",
  },
  [
    "districts:stats",
    "driver:status",
    "driver:registered",
    "order:new",
    "order:completed",
    "order:cancelled",
  ],
);
</script>
<template>
  <div class="space-y-5">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="page-heading">Обзор</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Заказы, водители и районы.
        </p>
      </div>
      <Button as-child class="min-h-11"
        ><RouterLink to="/adminOrders?create=1"
          ><Plus class="size-4" />Создать заказ</RouterLink
        ></Button
      >
    </header>
    <PageState :loading="loading" :error="error" @retry="load" />
    <template v-if="!loading && !error">
      <section
        class="grid grid-cols-3 divide-x rounded-lg border bg-card"
        aria-label="Текущая ситуация"
      >
        <RouterLink
          to="/adminOrders"
          class="min-w-0 p-3 sm:p-4 hover:bg-secondary/50"
        >
          <p class="text-2xl font-semibold leading-tight tabular-nums">
            {{ data.activeOrders }}
          </p>
          <p class="mt-1 text-xs text-muted-foreground">Активные заказы</p>
        </RouterLink>
        <RouterLink
          to="/adminDrivers"
          class="min-w-0 p-3 sm:p-4 hover:bg-secondary/50"
        >
          <p class="text-2xl font-semibold leading-tight tabular-nums">
            {{ data.onlineDrivers
            }}<span class="ml-1 text-sm font-normal text-muted-foreground"
              >/ {{ data.totalDrivers }}</span
            >
          </p>
          <p class="mt-1 text-xs text-muted-foreground">Водители на линии</p>
        </RouterLink>
        <RouterLink
          to="/adminDrivers?status=PENDING"
          class="min-w-0 p-3 sm:p-4 hover:bg-secondary/50"
        >
          <p class="text-2xl font-semibold leading-tight tabular-nums">
            {{ data.pendingDrivers }}
          </p>
          <p class="mt-1 text-xs text-muted-foreground">Ожидают проверки</p>
        </RouterLink>
      </section>
      <section>
        <div class="mb-2 flex items-center justify-between gap-3">
          <h2 class="text-base font-semibold">Ситуация по районам</h2>
          <RouterLink
            to="/adminMonitoring"
            class="inline-flex min-h-11 items-center gap-1 text-sm"
            >На карте<ArrowUpRight class="size-4"
          /></RouterLink>
        </div>
        <div class="overflow-hidden rounded-lg border bg-card">
          <div
            class="grid grid-cols-[minmax(0,1fr)_75px_85px] gap-2 border-b bg-secondary/40 px-3 py-2 text-xs text-muted-foreground sm:grid-cols-[1fr_140px_140px] sm:px-4"
          >
            <span>Район</span><span class="text-right">Заказы</span
            ><span class="text-right">Свободны</span>
          </div>
          <div
            v-for="region in data.regions"
            :key="region.id"
            class="grid grid-cols-[minmax(0,1fr)_75px_85px] items-center gap-2 border-b px-3 py-3 text-sm last:border-b-0 sm:grid-cols-[1fr_140px_140px] sm:px-4"
          >
            <span class="break-words font-medium">{{ region.name }}</span>
            <span class="text-right tabular-nums"
              >{{ region.activeOrders
              }}<span class="sr-only"> заказов</span></span
            >
            <span class="text-right tabular-nums"
              >{{ region.freeDrivers
              }}<span class="sr-only"> свободных водителей</span></span
            >
          </div>
        </div>
      </section>
      <OperationalToday />
      <section class="border-t pt-4" aria-label="История завершённых поездок">
        <h2 class="mb-3 text-sm font-semibold">
          Завершённые поездки за всё время
        </h2>
        <dl class="grid gap-3 text-sm sm:grid-cols-3">
          <div class="flex items-baseline justify-between gap-3 sm:block">
            <dt class="text-xs text-muted-foreground">Всего</dt>
            <dd class="font-semibold tabular-nums sm:mt-1">
              {{ data.completedTrips }}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-3 sm:block">
            <dt class="text-xs text-muted-foreground">Стоимость поездок</dt>
            <dd class="font-semibold tabular-nums sm:mt-1">
              {{
                data.pricedCompletedTrips ? money(data.completedTripValue) : "—"
              }}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-3 sm:block">
            <dt class="text-xs text-muted-foreground">
              Средняя известная стоимость
            </dt>
            <dd class="font-semibold tabular-nums sm:mt-1">
              {{
                data.pricedCompletedTrips
                  ? money(data.averageCompletedTripValue)
                  : "—"
              }}
            </dd>
          </div>
        </dl>
        <p
          v-if="data.pricedCompletedTrips < data.completedTrips"
          class="mt-2 text-xs text-muted-foreground"
        >
          Стоимость известна для {{ data.pricedCompletedTrips }} из
          {{ data.completedTrips }} поездок.
        </p>
      </section>
    </template>
  </div>
</template>
