<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { Search, ChevronRight } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Badge } from "@/shared/ui/badge";
import { adminApi } from "@/shared/api";
import { money, statusLabel, type Driver, type Page } from "./domain";
import { useResource } from "./useResource";
import PageState from "./components/PageState.vue";
const route = useRoute(),
  filter = ref(String(route.query.status || "")),
  search = ref(""),
  page = ref(1);
const { data, loading, error, load } = useResource(
  async () =>
    (
      await adminApi.get<Page<Driver>>("/admin/drivers", {
        params: {
          status: filter.value || undefined,
          page: page.value,
          limit: 50,
        },
      })
    ).data,
  { items: [], total: 0, page: 1, limit: 50 },
  ["driver:status", "driver:registered", "driver:updated", "balance:updated"],
);
watch(filter, () => {
  page.value = 1;
  void load();
});
watch(page, () => {
  void load();
});
const visible = computed(() =>
  data.value.items.filter((d) =>
    `${d.user.fullName} ${d.user.phone} ${d.currentVehicle?.plateNumber ?? ""}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
</script>
<template>
  <div class="space-y-6">
    <header>
      <p class="eyebrow">Команда</p>
      <h1 class="page-heading">
        Водители <span class="text-muted-foreground">{{ data.total }}</span>
      </h1>
      <p class="mt-2 text-muted-foreground">
        Доступ, автомобили и синтетические балансы.
      </p>
    </header>
    <div class="flex flex-wrap items-center gap-3">
      <div class="relative min-w-52 flex-1">
        <Search
          class="absolute left-3 top-3 size-4 text-muted-foreground"
        /><Input
          v-model="search"
          aria-label="Поиск среди загруженных водителей"
          placeholder="Имя, телефон или номер машины"
          class="pl-9"
        />
      </div>
      <select
        v-model="filter"
        aria-label="Статус водителя"
        class="native-select"
      >
        <option value="">Все статусы</option>
        <option value="PENDING">На проверке</option>
        <option value="APPROVED">Одобрены</option>
        <option value="BLOCKED">Заблокированы</option>
      </select>
    </div>
    <PageState
      :loading="loading"
      :error="error"
      :empty="!visible.length"
      @retry="load"
    />
    <div
      v-if="!loading && !error"
      class="overflow-hidden rounded-xl border bg-card"
    >
      <RouterLink
        v-for="driver in visible"
        :key="driver.id"
        :to="`/adminDrivers/${driver.id}`"
        class="flex items-center gap-4 border-b p-4 transition-colors last:border-0 hover:bg-muted/60"
        ><span
          class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary"
          >{{ driver.user.fullName?.slice(0, 1) || "В" }}</span
        >
        <div class="min-w-0 flex-1">
          <p class="truncate font-medium">{{ driver.user.fullName }}</p>
          <p class="text-xs text-muted-foreground">
            {{ driver.user.phone }} ·
            {{ driver.currentVehicle?.plateNumber || "Нет автомобиля" }}
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ driver.district?.name || "Без района" }}
          </p>
        </div>
        <div class="space-y-2 text-right">
          <Badge
            :variant="driver.status === 'BLOCKED' ? 'destructive' : 'secondary'"
            >{{ statusLabel(driver.status) }}</Badge
          >
          <p
            class="text-xs"
            :class="driver.isOnline ? 'text-primary' : 'text-muted-foreground'"
          >
            {{ driver.isOnline ? "На линии" : "Не в сети" }} ·
            {{ money(driver.user.balance?.amount) }}
          </p>
        </div>
        <ChevronRight class="hidden size-4 text-muted-foreground sm:block"
      /></RouterLink>
    </div>
    <div v-if="data.total > 50" class="flex items-center justify-between">
      <Button
        variant="outline"
        :disabled="page === 1 || loading"
        @click="page--"
        >Назад</Button
      ><span class="text-sm">Страница {{ page }}</span
      ><Button
        variant="outline"
        :disabled="page * 50 >= data.total || loading"
        @click="page++"
        >Далее</Button
      >
    </div>
  </div>
</template>
