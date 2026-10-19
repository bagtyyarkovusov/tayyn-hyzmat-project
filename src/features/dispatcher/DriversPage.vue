<script setup lang="ts">
import { formatPhone } from "@/shared/phone";
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { Search, ChevronRight } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Badge } from "@/shared/ui/badge";
import { adminApi } from "@/shared/api";
import { money, statusLabel, type Driver, type Page } from "./domain";
import { useResource } from "./useResource";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";
import CreateDriverForm from "./components/CreateDriverForm.vue";
import PageState from "./components/PageState.vue";
const router = useRouter(),
  create = ref(false);
const route = useRoute(),
  filter = ref(
    ["APPROVED", "BLOCKED"].includes(String(route.query.status))
      ? String(route.query.status)
      : "",
  ),
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
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="page-heading">
          Водители <span class="text-muted-foreground">{{ data.total }}</span>
        </h1>
        <p class="mt-2 text-muted-foreground">Доступ, автомобили и балансы.</p>
      </div>
      <Button @click="create = true">Добавить водителя</Button>
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
        <option value="APPROVED">Активны</option>
        <option value="BLOCKED">Заблокированы</option>
      </select>
    </div>
    <PageState
      :loading="loading"
      :error="error"
      :empty="!visible.length"
      :empty-title="
        search || filter ? 'Водители не найдены' : 'Водителей пока нет'
      "
      :empty-description="
        search || filter
          ? 'Измените поиск или статус.'
          : 'Добавьте водителя, чтобы начать работу.'
      "
      @retry="load"
    />
    <div
      v-if="!loading && !error && visible.length"
      class="overflow-hidden rounded-xl border bg-card"
    >
      <RouterLink
        v-for="driver in visible"
        :key="driver.id"
        :to="`/adminDrivers/${driver.id}`"
        class="grid grid-cols-[2.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 border-b p-4 transition-colors last:border-0 hover:bg-muted/60 sm:flex sm:items-center sm:gap-4"
        ><span
          class="row-span-2 flex size-10 shrink-0 self-center items-center justify-center rounded-full bg-primary/10 font-semibold text-primary"
          >{{ driver.user.fullName?.slice(0, 1) || "В" }}</span
        >
        <div class="min-w-0 flex-1">
          <p class="line-clamp-2 break-words font-medium">
            {{ driver.user.fullName }}
          </p>
          <p class="text-xs text-muted-foreground">
            {{ formatPhone(driver.user.phone) }} ·
            {{ driver.currentVehicle?.plateNumber || "Нет автомобиля" }}
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ driver.district?.name || "Без района" }}
          </p>
        </div>
        <div
          class="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 sm:block sm:shrink-0 sm:space-y-2 sm:text-right"
        >
          <Badge
            :variant="driver.status === 'BLOCKED' ? 'destructive' : 'secondary'"
            >{{ statusLabel(driver.status) }}</Badge
          >
          <p
            class="text-xs"
            :class="driver.isOnline ? 'text-primary' : 'text-muted-foreground'"
          >
            {{ driver.isOnline ? "На линии" : "Не в сети" }} ·
            <span class="block"
              >Всего
              {{
                money(driver.user.balance?.total ?? driver.user.balance?.amount)
              }}</span
            ><span class="mt-1 block text-xs text-muted-foreground"
              >Удержано {{ money(driver.user.balance?.held) }} · Доступно
              {{
                money(
                  driver.user.balance?.available ?? driver.user.balance?.amount,
                )
              }}</span
            >
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
    <Dialog v-model:open="create">
      <DialogContent class="max-h-[90dvh] overflow-y-auto">
        <DialogHeader
          ><DialogTitle>Новый водитель</DialogTitle
          ><DialogDescription
            >Укажите имя, телефон и пароль.</DialogDescription
          ></DialogHeader
        >
        <CreateDriverForm
          @created="
            (driver) => {
              create = false;
              router.push(`/adminDrivers/${driver.id}`);
            }
          "
        />
      </DialogContent>
    </Dialog>
  </div>
</template>
