<script setup lang="ts">
import { Button } from "@/shared/ui/button";
import { adminApi } from "@/shared/api";
import { date, type Activity } from "./domain";
import { useResource } from "./useResource";
import PageState from "./components/PageState.vue";
const { data, loading, error, load } = useResource(
  async () =>
    (
      await adminApi.get<{ items: Activity[] }>("/admin/activity", {
        params: { limit: 100 },
      })
    ).data.items,
  [],
);
</script>
<template>
  <div class="space-y-6">
    <header class="flex items-end justify-between gap-4">
      <div>
        <h1 class="page-heading">Активность</h1>
        <p class="mt-2 text-muted-foreground">
          Последние 100 событий диспетчерской.
        </p>
      </div>
      <Button variant="outline" :disabled="loading" @click="load"
        >Обновить</Button
      >
    </header>
    <PageState
      :loading="loading"
      :error="error"
      :empty="!data.length"
      empty-title="Поездок пока нет"
      empty-description="Завершённые поездки появятся здесь."
      @retry="load"
    />
    <ol
      v-if="!loading && !error"
      class="overflow-hidden rounded-xl border bg-card"
    >
      <li
        v-for="event in data"
        :key="event.id"
        class="flex gap-4 border-b p-5 last:border-0"
      >
        <span class="mt-2 size-2 shrink-0 rounded-full bg-primary" />
        <div>
          <p class="text-sm font-medium">{{ event.summary }}</p>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ event.actor || "Система" }} · {{ date(event.at) }}
          </p>
        </div>
      </li>
    </ol>
  </div>
</template>
