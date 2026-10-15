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
      <Button as-child
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
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <article
        v-for="district in data"
        :key="district.id"
        class="rounded-xl border bg-card p-5"
      >
        <div class="flex items-start justify-between gap-3">
          <h2 class="font-semibold">{{ district.name }}</h2>
          <MapPin class="size-4 shrink-0 text-primary" />
        </div>
        <div class="mt-6 grid grid-cols-2 gap-3">
          <div>
            <p class="text-2xl font-semibold tabular-nums">
              {{ district.activeOrders }}
            </p>
            <p class="mt-1 text-xs text-muted-foreground">активных заказов</p>
          </div>
          <div>
            <p class="text-2xl font-semibold tabular-nums">
              {{ district.freeDrivers }}
            </p>
            <p class="mt-1 text-xs text-muted-foreground">
              свободных водителей
            </p>
          </div>
        </div>
        <RouterLink
          :to="`/adminDistricts/boundaries?district=${district.id}`"
          class="mt-5 flex items-center justify-between border-t pt-4 text-sm text-primary"
          >Посмотреть границу<ArrowUpRight class="size-4"
        /></RouterLink>
      </article>
    </div>
  </div>
</template>
