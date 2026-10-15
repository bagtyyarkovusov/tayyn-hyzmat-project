<script setup lang="ts">
import { computed, ref } from "vue";
import {
  MapPin,
  RefreshCw,
  ChevronRight,
  LocateFixed,
  Radio,
} from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";
import { useDriver } from "./useDriver";
import { enableOrderAlerts } from "./alerts";
import { money } from "./model";
import IncomingOrder from "./components/IncomingOrder.vue";
import ActiveTrip from "./components/ActiveTrip.vue";
import AvailableOrders from "./components/AvailableOrders.vue";
const {
  state,
  refresh,
  setOnline,
  setDistrict,
  enableGps,
  dismissIncoming,
  countdown,
  session,
} = useDriver();
const selected = ref<string | null>(null),
  manualRegion = ref("");
const selectedDistrict = computed(() =>
  state.districts.find((d) => d.id === selected.value),
);
const ownRegion = computed(
  () =>
    state.districts.find((d) => d.id === state.profile?.districtId)?.name ||
    "Не определён",
);
</script>
<template>
  <div class="mx-auto max-w-3xl space-y-6">
    <header class="flex items-center justify-between gap-3">
      <div>
        <h1 class="page-heading">На линии</h1>
        <p class="muted text-sm">
          {{ state.profile?.user.fullName || "Рабочее место водителя" }}
        </p>
      </div>
      <Button
        variant="outline"
        size="icon"
        aria-label="Обновить данные"
        :disabled="state.loading"
        @click="refresh"
        ><RefreshCw class="size-4" :class="{ 'animate-spin': state.loading }"
      /></Button>
    </header>
    <p
      v-if="state.error"
      role="alert"
      class="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
    >
      {{ state.error }}
    </p>
    <p
      v-if="state.notice"
      role="status"
      class="rounded-lg bg-primary/10 p-3 text-primary"
    >
      {{ state.notice }}
    </p>
    <section class="panel space-y-4">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <Radio
            class="size-5"
            :class="
              state.profile?.isOnline ? 'text-primary' : 'text-muted-foreground'
            "
          />
          <div>
            <h2 class="font-semibold">
              {{
                state.profile?.isOnline
                  ? "Вы принимаете заказы"
                  : "Вы не на линии"
              }}
            </h2>
            <p class="muted text-sm">
              {{
                session.state.connected
                  ? "Связь с диспетчером установлена"
                  : "Переподключаемся к диспетчеру…"
              }}
            </p>
          </div>
        </div>
      </div>
      <div class="flex items-center justify-between gap-3 border-t pt-4">
        <div>
          <p class="muted text-xs">Тестовый баланс</p>
          <p class="text-xl font-semibold tabular-nums">
            {{ state.balance ? money(state.balance.amount) : "Загружаем…" }}
          </p>
        </div>
        <Button
          :variant="state.profile?.isOnline ? 'outline' : 'default'"
          :disabled="
            state.busy ||
            !state.profile ||
            (!state.profile.isOnline && Number(state.balance?.amount ?? 0) <= 0)
          "
          @click="setOnline"
          >{{
            state.busy
              ? "Сохраняем…"
              : state.profile?.isOnline
                ? "Уйти с линии"
                : "Выйти на линию"
          }}</Button
        >
      </div>
      <p
        v-if="state.balance && Number(state.balance.amount) <= 0"
        class="text-sm text-destructive"
      >
        Для получения заказов нужен положительный баланс. Напишите диспетчеру.
      </p>
    </section>
    <div class="flex flex-wrap items-center gap-3">
      <Button variant="ghost" @click="enableOrderAlerts"
        >Включить уведомления и звук</Button
      ><span class="muted text-xs">Для работающего браузера</span>
    </div>
    <ActiveTrip />
    <IncomingOrder />
    <section class="panel space-y-3">
      <div class="flex gap-3">
        <MapPin class="mt-1 size-5 shrink-0 text-primary" />
        <div>
          <h2 class="font-semibold">Мой район: {{ ownRegion }}</h2>
          <p class="muted text-sm">
            {{
              state.position
                ? `GPS · точность ${Math.round(state.position.accuracy)} м`
                : "Геолокация уточняет район автоматически."
            }}
          </p>
        </div>
      </div>
      <p v-if="state.gpsError" role="status" class="text-sm text-destructive">
        {{ state.gpsError }}
      </p>
      <Button variant="outline" :disabled="state.gpsPending" @click="enableGps"
        ><LocateFixed class="size-4" />{{
          state.gpsPending ? "Ищем GPS…" : "Включить GPS"
        }}</Button
      >
      <details class="border-t pt-3">
        <summary class="cursor-pointer text-sm font-medium">
          Выбрать район без GPS
        </summary>
        <p class="muted my-3 text-sm">
          Следующая успешная GPS-отправка снова определит район автоматически.
        </p>
        <form
          class="flex flex-wrap gap-2"
          @submit.prevent="setDistrict(manualRegion)"
        >
          <label for="manual-region" class="sr-only">Район вручную</label
          ><select
            id="manual-region"
            v-model="manualRegion"
            class="native-select min-h-11 min-w-0 flex-1"
            required
          >
            <option value="" disabled>Выберите район</option>
            <option v-for="d in state.districts" :key="d.id" :value="d.id">
              {{ d.name }}
            </option></select
          ><Button type="submit" :disabled="state.busy || !manualRegion"
            >Сохранить</Button
          >
        </form>
      </details>
    </section>
    <section>
      <h2 class="mb-3 text-lg font-semibold">Заказы по районам</h2>
      <p
        v-if="!state.profile?.isOnline"
        class="muted rounded-lg border p-6 text-center"
      >
        Выйдите на линию, чтобы просматривать и принимать заказы.
      </p>
      <p
        v-else-if="state.loading && !state.districts.length"
        role="status"
        class="muted py-6"
      >
        Загружаем районы…
      </p>
      <p v-else-if="!state.districts.length" class="muted py-6">
        Районы ещё не настроены. Свяжитесь с диспетчером.
      </p>
      <div v-else class="divide-y rounded-xl border bg-card">
        <button
          v-for="d in state.districts"
          :key="d.id"
          class="flex min-h-20 w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          @click="selected = d.id"
        >
          <div class="min-w-0 flex-1">
            <p class="break-words font-medium">
              {{ d.name
              }}<span
                v-if="d.id === state.profile?.districtId"
                class="ml-2 text-xs text-primary"
                >Мой район</span
              >
            </p>
            <p class="muted mt-1 text-xs">
              {{ d.freeDrivers }} свободных водителей
            </p>
          </div>
          <span class="tabular-nums text-sm">{{ d.activeOrders }} заказов</span
          ><ChevronRight class="size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>
    </section>
    <Dialog
      :open="!!selected"
      @update:open="
        (value) => {
          if (!value) selected = null;
        }
      "
      ><DialogContent class="max-h-[85dvh] overflow-y-auto"
        ><DialogHeader
          ><DialogTitle>Заказы района</DialogTitle
          ><DialogDescription
            >Выберите заказ и время прибытия.</DialogDescription
          ></DialogHeader
        ><AvailableOrders
          v-if="selectedDistrict"
          :district-id="selectedDistrict.id"
          :district-name="selectedDistrict.name" /></DialogContent
    ></Dialog>
  </div>
</template>
