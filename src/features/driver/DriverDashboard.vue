<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  MapPin,
  RefreshCw,
  ChevronRight,
  LocateFixed,
  Power,
  Bell,
  LoaderCircle,
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
const { state, refresh, setOnline, setDistrict, enableGps, session } =
  useDriver();
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
watch(
  () => state.active?.id,
  (orderId) => {
    if (orderId) selected.value = null;
  },
);
</script>
<template>
  <div class="mx-auto max-w-xl space-y-4">
    <header class="flex items-center justify-between gap-3">
      <h1 class="text-lg font-semibold">На линии</h1>
      <div class="flex items-center gap-2">
        <span
          class="text-sm font-semibold tabular-nums"
          aria-label="Тестовый баланс"
        >
          {{ state.balance ? money(state.balance.amount) : "…" }}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Обновить данные"
          :disabled="state.loading"
          @click="refresh"
        >
          <RefreshCw
            class="size-4"
            :class="{ 'animate-spin': state.loading }"
          />
        </Button>
      </div>
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
    <section
      aria-label="Выход на линию"
      class="flex flex-col items-center gap-3 py-2"
    >
      <Button
        variant="outline"
        class="size-24 rounded-full border-4 shadow-none [&_svg]:size-9 motion-safe:transition-[background-color,border-color,color,transform] motion-safe:duration-200 active:scale-95"
        :class="
          state.profile?.isOnline
            ? 'border-primary/25 bg-primary text-primary-foreground hover:bg-primary/90'
            : 'border-border bg-card text-muted-foreground hover:bg-muted'
        "
        :aria-label="
          state.profile?.isOnline ? 'Уйти с линии' : 'Выйти на линию'
        "
        :aria-pressed="!!state.profile?.isOnline"
        :aria-busy="state.busy"
        :disabled="
          state.busy ||
          !state.profile ||
          (!state.profile.isOnline && Number(state.balance?.amount ?? 0) <= 0)
        "
        @click="setOnline"
      >
        <LoaderCircle
          v-if="state.busy"
          class="motion-safe:animate-spin"
          aria-hidden="true"
        />
        <Power v-else :stroke-width="2.5" aria-hidden="true" />
      </Button>
      <span class="sr-only" role="status">{{
        state.profile?.isOnline ? "Вы принимаете заказы" : "Вы не на линии"
      }}</span>
      <p v-if="!session.state.connected" role="status" class="muted text-xs">
        Переподключаемся к диспетчеру…
      </p>
      <p
        v-if="state.balance && Number(state.balance.amount) <= 0"
        class="text-sm text-destructive"
      >
        Для выхода на линию пополните баланс у диспетчера.
      </p>
    </section>
    <ActiveTrip />
    <IncomingOrder />
    <section class="space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2 text-sm font-medium">
          <MapPin class="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span class="break-words">{{ ownRegion }}</span>
        </div>
        <div class="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            class="min-h-11"
            :disabled="state.gpsPending"
            aria-label="Включить GPS"
            @click="enableGps"
          >
            <LocateFixed class="size-4" aria-hidden="true" />
            {{ state.gpsPending ? "Ищем…" : "GPS" }}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            class="min-h-11"
            aria-label="Включить уведомления и звук"
            @click="enableOrderAlerts"
          >
            <Bell class="size-4" aria-hidden="true" />Звук
          </Button>
        </div>
      </div>
      <p v-if="state.position" class="muted text-xs" role="status">
        GPS · точность {{ Math.round(state.position.accuracy) }} м
      </p>
      <p v-if="state.gpsError" role="status" class="text-sm text-destructive">
        {{ state.gpsError }}
      </p>
      <details class="border-t pt-2">
        <summary class="cursor-pointer text-sm font-medium">
          Выбрать район
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
      <h2 class="mb-2 text-base font-semibold">Заказы по районам</h2>
      <p
        v-if="!state.profile?.isOnline"
        class="muted rounded-lg border p-3 text-center text-sm"
      >
        Включите кнопку, чтобы принимать заказы.
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
          class="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
