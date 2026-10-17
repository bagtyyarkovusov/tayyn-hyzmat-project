<script setup lang="ts">
import type { District, Driver } from "../domain";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Button } from "@/shared/ui/button";
const search = defineModel<string>("search", { required: true });
const region = defineModel<string>("region", { required: true });
const status = defineModel<string>("status", { required: true });
defineProps<{
  idPrefix: string;
  drivers: Driver[];
  regions: District[];
  states: Record<string, string>;
  total: number;
  selected: string;
  loading: boolean;
  error: string;
}>();
const emit = defineEmits<{ select: [driver: Driver] }>();
const stateLabels: Record<string, string> = {
  available: "Свободен",
  busy: "В поездке",
  stale: "Проверить GPS",
  offline: "Не в сети",
};
</script>
<template>
  <section class="monitoring-roster" aria-label="Список водителей">
    <div class="space-y-2 border-b p-3">
      <Label :for="`${idPrefix}-search`">Поиск водителя</Label>
      <Input
        :id="`${idPrefix}-search`"
        v-model="search"
        type="search"
        placeholder="Имя, телефон или номер авто"
      />
      <div class="grid grid-cols-2 gap-2">
        <div>
          <Label :for="`${idPrefix}-region`" class="sr-only">Район</Label
          ><select
            :id="`${idPrefix}-region`"
            v-model="region"
            class="native-select min-h-11 w-full"
          >
            <option value="">Все районы</option>
            <option value="outside">Вне районов</option>
            <option v-for="item in regions" :key="item.id" :value="item.id">
              {{ item.name }}
            </option>
          </select>
        </div>
        <div>
          <Label :for="`${idPrefix}-status`" class="sr-only"
            >Статус водителя</Label
          ><select
            :id="`${idPrefix}-status`"
            v-model="status"
            class="native-select min-h-11 w-full"
          >
            <option value="all">Все статусы</option>
            <option value="available">Свободные</option>
            <option value="busy">В поездке</option>
            <option value="stale">Проверить GPS</option>
            <option value="offline">Не в сети</option>
          </select>
        </div>
      </div>
      <p
        v-if="!loading && !error"
        class="text-xs text-muted-foreground"
        role="status"
      >
        Показано {{ drivers.length }} из {{ total }}
      </p>
      <p v-else class="text-xs text-muted-foreground" role="status">
        {{ loading ? "Загружаем водителей…" : "Данные не обновлены" }}
      </p>
    </div>
    <div class="monitoring-rows" aria-label="Результаты поиска водителей">
      <button
        v-for="driver in drivers"
        :key="driver.id"
        type="button"
        class="monitoring-driver"
        :aria-pressed="selected === driver.id"
        :aria-label="driver.user.fullName"
        :aria-describedby="`${idPrefix}-${driver.id}-detail`"
        @click="emit('select', driver)"
      >
        <span class="flex min-w-0 items-start justify-between gap-2"
          ><span class="min-w-0 flex-1 truncate font-medium">{{
            driver.user.fullName
          }}</span
          ><span
            class="max-w-[55%] text-right text-xs"
            :class="
              states[driver.id] === 'available'
                ? 'text-success'
                : 'text-muted-foreground'
            "
            >{{ stateLabels[states[driver.id]]
            }}<template v-if="!driver.isOnline && driver.hasActiveTrip">
              · Поездка не завершена</template
            ></span
          ></span
        >
        <span
          :id="`${idPrefix}-${driver.id}-detail`"
          class="block truncate text-xs text-muted-foreground"
          >{{ driver.currentVehicle?.plateNumber || "Без авто" }} ·
          {{ driver.district?.name || "Вне районов"
          }}<span class="sr-only">
            · {{ stateLabels[states[driver.id]] }}</span
          ></span
        >
      </button>
      <div v-if="!loading && !error && !drivers.length" class="p-4 text-sm">
        <p>Водители не найдены</p>
        <Button
          v-if="search || region || status !== 'all'"
          variant="ghost"
          class="mt-2 min-h-11"
          @click="
            search = '';
            region = '';
            status = 'all';
          "
          >Сбросить фильтры</Button
        >
      </div>
    </div>
  </section>
</template>
<style scoped>
.monitoring-roster {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--card);
  overflow: hidden;
}
.monitoring-rows {
  max-height: min(48dvh, 480px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.monitoring-driver {
  display: block;
  width: 100%;
  min-height: 60px;
  padding: 0.5rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.monitoring-driver:hover,
.monitoring-driver[aria-pressed="true"] {
  background: var(--secondary);
}
.monitoring-driver:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
</style>
