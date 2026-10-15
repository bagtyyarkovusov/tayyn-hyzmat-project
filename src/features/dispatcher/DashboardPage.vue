<script setup lang="ts">
import { RouterLink } from "vue-router";
import { ArrowUpRight, Plus, Radio } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { adminApi } from "@/shared/api";
import { useResource } from "./useResource";
import {
  money,
  type District,
  type Driver,
  type Order,
  type Page,
} from "./domain";
import PageState from "./components/PageState.vue";
const { data, loading, error, load } = useResource(
  async () => {
    const [regions, drivers, orders, completed, pending] = await Promise.all([
      adminApi.get<District[]>("/districts"),
      adminApi.get<Page<Driver>>("/admin/drivers", { params: { limit: 100 } }),
      adminApi.get<Page<Order>>("/admin/orders", {
        params: { status: "active", limit: 1 },
      }),
      adminApi.get<Page<Order>>("/admin/orders", {
        params: { status: "completed", limit: 100 },
      }),
      adminApi.get<Page<Driver>>("/admin/drivers", {
        params: { status: "PENDING", limit: 1 },
      }),
    ]);
    return {
      regions: regions.data,
      drivers: drivers.data.items,
      orders: orders.data.total,
      totalDrivers: drivers.data.total,
      pending: pending.data.total,
      completed: completed.data.total,
      revenue: completed.data.items.reduce(
        (sum, o) => sum + Number(o.priceFinal ?? o.priceEstimated ?? 0),
        0,
      ),
      revenueCount: completed.data.items.length,
    };
  },
  {
    regions: [] as District[],
    drivers: [] as Driver[],
    orders: 0,
    totalDrivers: 0,
    pending: 0,
    completed: 0,
    revenue: 0,
    revenueCount: 0,
  },
  [
    "districts:stats",
    "driver:status",
    "order:new",
    "order:completed",
    "order:cancelled",
  ],
);
</script>
<template>
  <div class="space-y-7">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="page-heading">Рабочая смена</h1>
        <p class="mt-2 text-muted-foreground">
          Заказы, водители и районы в одном месте.
        </p>
      </div>
      <Button as-child
        ><RouterLink to="/adminOrders?create=1"
          ><Plus class="size-4" />Создать заказ</RouterLink
        ></Button
      >
    </header>
    <PageState :loading="loading" :error="error" @retry="load" /><template
      v-if="!loading && !error"
      ><section class="grid gap-4 sm:grid-cols-3" aria-label="Сводка смены">
        <div class="rounded-xl border bg-primary p-5 text-primary-foreground">
          <p class="text-sm opacity-80">Активные заказы</p>
          <p class="mt-3 text-4xl font-semibold tabular-nums">
            {{ data.orders }}
          </p>
          <RouterLink
            to="/adminOrders"
            class="mt-5 flex items-center gap-1 text-sm"
            >Открыть заказы <ArrowUpRight class="size-4"
          /></RouterLink>
        </div>
        <div class="rounded-xl border bg-card p-5">
          <p class="text-sm text-muted-foreground">Водители на линии</p>
          <p class="mt-3 text-4xl font-semibold tabular-nums">
            {{ data.drivers.filter((d) => d.isOnline).length }}
          </p>
          <p class="mt-5 text-sm text-muted-foreground">
            из {{ data.totalDrivers }} водителей<span
              v-if="data.totalDrivers > 100"
            >
              · показаны последние 100</span
            >
          </p>
        </div>
        <div class="rounded-xl border bg-card p-5">
          <p class="text-sm text-muted-foreground">Ожидают проверки</p>
          <p class="mt-3 text-4xl font-semibold tabular-nums">
            {{ data.pending }}
          </p>
          <RouterLink
            to="/adminDrivers?status=PENDING"
            class="mt-5 inline-block text-sm text-primary"
            >Проверить заявки →</RouterLink
          >
        </div>
      </section>
      <section
        class="flex flex-wrap justify-between gap-5 rounded-xl border bg-card p-5"
        aria-label="История завершённых поездок"
      >
        <div>
          <p class="text-xs text-muted-foreground">Завершённых поездок</p>
          <p class="mt-2 text-xl font-semibold tabular-nums">
            {{ data.completed }}
          </p>
        </div>
        <div>
          <p class="text-xs text-muted-foreground">
            Сумма последних {{ data.revenueCount }} поездок
          </p>
          <p class="mt-2 text-xl font-semibold tabular-nums">
            {{ money(data.revenue) }}
          </p>
        </div>
        <div>
          <p class="text-xs text-muted-foreground">
            Средняя стоимость последних {{ data.revenueCount }} поездок
          </p>
          <p class="mt-2 text-xl font-semibold tabular-nums">
            {{
              money(data.revenueCount ? data.revenue / data.revenueCount : 0)
            }}
          </p>
        </div>
      </section>
      <section>
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold">Ситуация по районам</h2>
          <RouterLink to="/adminMonitoring" class="text-sm text-primary"
            >На карте →</RouterLink
          >
        </div>
        <div class="overflow-hidden rounded-xl border bg-card">
          <div
            v-for="region in data.regions"
            :key="region.id"
            class="grid grid-cols-[1fr_auto] gap-4 border-b p-4 last:border-b-0 sm:grid-cols-[1fr_160px_160px]"
          >
            <span class="font-medium">{{ region.name }}</span
            ><span class="text-sm text-muted-foreground"
              >{{ region.activeOrders }} заказов</span
            ><span class="hidden items-center gap-2 text-sm sm:flex"
              ><Radio class="size-3 text-primary" />{{
                region.freeDrivers
              }}
              свободны</span
            >
          </div>
        </div>
      </section></template
    >
  </div>
</template>
