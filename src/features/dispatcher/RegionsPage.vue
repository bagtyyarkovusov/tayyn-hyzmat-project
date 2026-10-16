<script setup lang="ts">
import { RouterLink } from "vue-router";
import { MapPin, ArrowUpRight } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { adminApi } from "@/shared/api";
import type { District } from "./domain";
import { useResource } from "./useResource";
import PageState from "./components/PageState.vue";
const { data, loading, error, load } = useResource(
  async () => (await adminApi.get<District[]>("/districts")).data,
  [],
  ["districts:stats"],
);
</script>
<template>
  <div class="space-y-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="page-heading">Районы</h1>
        <p class="mt-2 text-muted-foreground">
          Спрос и доступность водителей по городу.
        </p>
      </div>
      <Button as-child class="min-h-11"
        ><RouterLink to="/adminDistricts/boundaries"
          ><MapPin class="size-4" />Границы районов</RouterLink
        ></Button
      >
    </header>
    <PageState
      :loading="loading"
      :error="error"
      :empty="!data.length"
      @retry="load"
    />
    <div v-if="data.length" class="overflow-hidden rounded-lg border bg-card">
      <div class="region-row bg-secondary/40 text-xs text-muted-foreground">
        <span>Район</span><span class="text-right">Заказы</span
        ><span class="text-right">Свободны</span
        ><span class="sr-only">Граница</span>
      </div>
      <article
        v-for="district in data"
        :key="district.id"
        class="region-row text-sm"
      >
        <h2 class="min-w-0 break-words font-medium">{{ district.name }}</h2>
        <span class="text-right tabular-nums"
          >{{ district.activeOrders
          }}<span class="sr-only"> активных заказов</span></span
        >
        <span class="text-right tabular-nums"
          >{{ district.freeDrivers
          }}<span class="sr-only"> свободных водителей</span></span
        >
        <RouterLink
          :to="`/adminDistricts/boundaries?district=${district.id}`"
          class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="`Посмотреть границу: ${district.name}`"
          ><ArrowUpRight class="size-4"
        /></RouterLink>
      </article>
    </div>
  </div>
</template>
<style scoped>
.region-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 56px 64px 44px;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--border);
}
.region-row:last-child {
  border-bottom: 0;
}
@media (min-width: 640px) {
  .region-row {
    grid-template-columns: minmax(0, 1fr) 140px 140px 44px;
    padding-inline: 1rem;
  }
}
</style>
