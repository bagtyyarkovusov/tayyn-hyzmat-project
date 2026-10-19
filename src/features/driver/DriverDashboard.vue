<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useDocumentVisibility, useOnline } from "@vueuse/core";
import {
  MapPin,
  LocateFixed,
  Power,
  LoaderCircle,
  MapPinOff,
  Wifi,
  WifiOff,
} from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";
import {
  useDriver,
  canControlShift,
  connectionRecovering,
  dispatcherConnected,
  OFFER_BACK_GUARD_MS,
} from "./useDriver";
import { useDriverAddress } from "./useDriverAddress";
import { money } from "./model";
import { localRegionAt } from "./local-region";
import IncomingOrder from "./components/IncomingOrder.vue";
import DriverFeedback from "./components/DriverFeedback.vue";
import ActiveTripFeed from "./components/ActiveTripFeed.vue";
import ActiveTrip from "./components/ActiveTrip.vue";
import AvailableOrders from "./components/AvailableOrders.vue";
const { state, setOnline, closeIncoming } = useDriver({
  localGps: true,
});
const { address } = useDriverAddress(
  () => state.position,
  () => state.profile?.id,
  () => state.gpsFixReady && (!state.profile?.isOnline || canControlShift()),
  {
    online: () => !!state.profile?.isOnline && canControlShift(),
    capturedAt: () => state.locationUpdatedAt,
    onlineRequest: () => state.addressLookupRequest,
    transitionPending: () => state.busy,
    connected: dispatcherConnected,
  },
);
const selected = ref<string | null>(null);
const visibility = useDocumentVisibility();
const networkOnline = useOnline();
const connectionReady = computed(
  () => networkOnline.value && dispatcherConnected(),
);
const connectionState = computed(() =>
  connectionReady.value
    ? "ready"
    : connectionRecovering()
      ? "reconnecting"
      : "disconnected",
);
const localFixFresh = computed(() => state.gpsFixReady);
// GPS is a device capability. It stays green while the phone has a fresh
// local fix, even when the dispatcher connection is down. Server acknowledgement
// remains a separate requirement for starting a shift and claiming an order.
const gpsStatusReady = computed(() => localFixFresh.value);
const locationReady = computed(
  () => localFixFresh.value && state.gpsReady && connectionReady.value,
);
const locationState = computed(() =>
  gpsStatusReady.value ? "ready" : state.gpsBlocked ? "blocked" : "searching",
);
const gpsLabel = computed(() =>
  locationState.value === "ready"
    ? "GPS: актуальные координаты"
    : locationState.value === "blocked"
      ? "GPS: нет доступа или местоположение выключено"
      : "GPS: поиск",
);
const connectionLabel = computed(() =>
  connectionState.value === "ready"
    ? "Связь: подключено"
    : connectionState.value === "reconnecting"
      ? "Связь: переподключение"
      : "Связь: нет соединения",
);
const shiftElsewhere = computed(() => state.profile?.canControlShift === false);
const liveOnline = computed(
  () => canControlShift() && !!state.profile?.isOnline && locationReady.value,
);
const availabilityDescription = computed(() =>
  shiftElsewhere.value
    ? "Смена активна на другом устройстве."
    : !state.profile?.isOnline
      ? "Не на линии."
      : !connectionReady.value
        ? "Нет связи с диспетчером. Переподключаемся."
        : !state.gpsReady
          ? "Нет актуального GPS."
          : "На линии. Связь с диспетчером установлена.",
);
const availabilityPulse = ref(false);
watch(
  () => state.profile?.isOnline,
  (online, previous) => {
    if (
      typeof previous === "boolean" &&
      typeof online === "boolean" &&
      online !== previous
    )
      availabilityPulse.value = true;
  },
);
watch(
  () => state.profile?.isOnline,
  (online) => {
    // Keep the selected queue through a transient connection/GPS sync loss so
    // it can recover live when readiness returns. Close it only after the
    // driver actually leaves the line.
    if (!online) selected.value = null;
  },
);
const tripOpen = ref(false);
const selectedDistrict = computed(() =>
  state.districts.find((d) => d.id === selected.value),
);
const currentLocalRegion = computed(() =>
  localFixFresh.value && state.position
    ? localRegionAt(state.districts, state.position)
    : null,
);
const ownRegion = computed(
  () => currentLocalRegion.value?.name || "Вне районов",
);
const highlightedRegionId = computed(() =>
  connectionReady.value ? currentLocalRegion.value?.id : undefined,
);
const blockers = computed(() => {
  const messages: string[] = [];
  if (shiftElsewhere.value)
    return [
      "Смена активна на другом устройстве. Завершите её там, чтобы выйти на линию здесь.",
    ];
  if (state.balance && Number(state.balance.amount) <= 0)
    messages.push("Для выхода на линию пополните баланс у диспетчера.");
  return messages;
});
watch(
  () => state.incoming?.privateOfferExpiresAt,
  (expiry) => {
    if (expiry) selected.value = null;
  },
);
const incomingOpen = computed(
  () => !!state.incoming && !state.active && !selected.value,
);
watch(
  () => state.active?.id,
  (id) => {
    if (id) {
      selected.value = null;
    }
    tripOpen.value = !!id;
  },
);
</script>
<template>
  <div class="driver-home mx-auto flex h-full max-w-xl flex-col gap-2">
    <h1 class="sr-only">Заказы по районам</h1>
    <div class="driver-controls flex shrink-0 flex-col gap-2">
      <header class="flex min-h-14 shrink-0 items-center gap-3">
        <span
          class="mr-auto whitespace-nowrap text-xl font-bold tabular-nums text-foreground"
          aria-label="Баланс"
          >{{ state.balance ? money(state.balance.amount) : "…" }}</span
        >
        <div class="flex shrink-0 items-center gap-5">
          <div
            role="group"
            aria-label="GPS и связь"
            class="flex items-center gap-3"
          >
            <span
              role="status"
              class="flex size-6 items-center justify-center"
              :class="
                locationState === 'ready'
                  ? 'text-success'
                  : locationState === 'blocked'
                    ? 'text-destructive'
                    : 'text-amber-700 dark:text-amber-300'
              "
              :data-state="locationState"
              :aria-label="gpsLabel"
            >
              <MapPinOff
                v-if="locationState === 'blocked'"
                class="size-6"
                aria-hidden="true"
              />
              <LocateFixed v-else class="size-6" aria-hidden="true" />
            </span>
            <span
              role="status"
              class="flex size-6 items-center justify-center"
              :class="
                connectionState === 'ready'
                  ? 'text-success'
                  : connectionState === 'reconnecting'
                    ? 'text-amber-700 dark:text-amber-300'
                    : 'text-destructive'
              "
              :data-state="connectionState"
              :aria-label="connectionLabel"
            >
              <Wifi
                v-if="connectionState !== 'disconnected'"
                class="size-6"
                aria-hidden="true"
              />
              <WifiOff v-else class="size-6" aria-hidden="true" />
            </span>
          </div>
          <Button
            variant="outline"
            class="relative size-11 shrink-0 overflow-visible rounded-full border shadow-none [&_svg]:size-5 motion-safe:transition-[background-color,border-color,color,transform] motion-safe:duration-200 active:scale-95"
            :class="
              !shiftElsewhere && state.profile?.isOnline
                ? liveOnline
                  ? 'border-emerald-300 bg-emerald-300 text-emerald-950 hover:bg-emerald-200 dark:border-emerald-400 dark:bg-emerald-400 dark:hover:bg-emerald-300'
                  : 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200'
                : 'border-red-200 bg-red-100 text-red-700 hover:bg-red-200 dark:border-red-800 dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-900'
            "
            :aria-label="
              !shiftElsewhere && state.profile?.isOnline
                ? 'Уйти с линии'
                : 'Выйти на линию'
            "
            :aria-description="availabilityDescription"
            :aria-pressed="!shiftElsewhere && !!state.profile?.isOnline"
            :aria-busy="state.busy"
            :disabled="
              shiftElsewhere ||
              state.busy ||
              state.locationSyncPending ||
              !state.profile ||
              (!state.profile.isOnline &&
                (Number(state.balance?.amount ?? 0) <= 0 || !connectionReady))
            "
            @click="setOnline"
          >
            <span
              v-if="liveOnline && visibility === 'visible'"
              class="online-beacon pointer-events-none absolute -inset-1 rounded-full border-2 border-success"
              aria-hidden="true"
            />
            <span
              v-if="availabilityPulse"
              :key="String(state.profile?.isOnline)"
              class="availability-pulse pointer-events-none absolute -inset-1 rounded-full border-2 border-success"
              aria-hidden="true"
              @animationend="availabilityPulse = false"
            />
            <LoaderCircle
              v-if="state.busy"
              class="motion-safe:animate-spin"
              aria-hidden="true"
            />
            <Power v-else :stroke-width="2.5" aria-hidden="true" />
          </Button>
        </div>
      </header>
      <div
        v-if="state.position"
        class="flex shrink-0 items-center justify-between gap-2"
      >
        <div
          class="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-sm"
          aria-label="Местоположение GPS"
        >
          <MapPin class="size-4 shrink-0 text-primary" />
          <span class="flex min-w-0 flex-col leading-snug">
            <span v-if="localFixFresh" class="truncate">{{ ownRegion }}</span>
            <span
              v-if="state.position"
              class="truncate text-xs text-muted-foreground"
              :title="address || undefined"
            >
              {{
                address ||
                `${state.position.lat.toFixed(4)}, ${state.position.lng.toFixed(4)}`
              }}
            </span>
          </span>
        </div>
      </div>
      <DriverFeedback
        :blockers="state.active && !shiftElsewhere ? [] : blockers"
        :error="incomingOpen || tripOpen ? '' : state.error"
        :notice="state.notice"
        :notice-event-id="state.noticeEventId"
        :attempt="state.actionAttempt"
      />
    </div>
    <ActiveTripFeed v-if="!shiftElsewhere" @details="tripOpen = true" />
    <p
      v-if="state.loading && !state.districts.length"
      role="status"
      class="muted text-sm"
    >
      Загружаем районы…
    </p>
    <p v-else-if="!state.districts.length" class="muted text-sm">
      Районы ещё не настроены. Свяжитесь с диспетчером.
    </p>
    <div
      v-else
      role="group"
      aria-label="Регионы"
      class="region-grid grid min-h-0 flex-1 grid-cols-3 gap-2"
      :class="{ 'region-grid-with-trip': state.active }"
      :style="{
        '--region-rows': Math.ceil(state.districts.length / 3),
        '--region-wide-rows': Math.ceil(state.districts.length / 5),
      }"
    >
      <button
        v-for="d in state.districts"
        :key="d.id"
        class="flex min-h-0 min-w-0 flex-col items-center justify-center gap-2 rounded-xl border p-2 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="[
          d.publicAvailableOrders > 0
            ? 'border-emerald-300 bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900'
            : 'bg-card hover:bg-secondary/50',
          d.id === highlightedRegionId ? 'ring-2 ring-blue-500' : '',
        ]"
        :aria-current="d.id === highlightedRegionId ? 'location' : undefined"
        :disabled="shiftElsewhere || !locationReady || !state.profile?.isOnline"
        @click="selected = d.id"
      >
        <span
          class="region-name break-words text-[13px] font-medium leading-tight"
          >{{ d.name
          }}<span v-if="d.id === highlightedRegionId" class="sr-only">
            · Мой район</span
          ></span
        >
        <strong
          class="region-score text-2xl font-semibold leading-none tabular-nums"
          :aria-label="`Заказов: ${d.publicAvailableOrders}. Машин на линии: ${d.onlineDrivers ?? d.freeDrivers}`"
          >{{
            locationReady && state.profile?.isOnline
              ? `${d.publicAvailableOrders}:${d.onlineDrivers ?? d.freeDrivers}`
              : "—:—"
          }}</strong
        >
      </button>
    </div>
    <Dialog :open="!!selected" @update:open="!$event && (selected = null)"
      ><DialogContent
        class="queue-dialog flex max-h-[85dvh] flex-col overflow-hidden"
        :aria-describedby="undefined"
        ><DialogHeader class="shrink-0 pr-8"
          ><DialogTitle>Заказы района</DialogTitle></DialogHeader
        >
        <AvailableOrders
          v-if="!shiftElsewhere && selectedDistrict && state.profile?.isOnline"
          v-show="locationReady"
          :district-id="selectedDistrict.id"
          :district-name="selectedDistrict.name"
        /> </DialogContent
    ></Dialog>
    <Dialog
      :open="incomingOpen"
      :back-guard-ms="OFFER_BACK_GUARD_MS"
      @update:open="!$event && closeIncoming()"
      ><DialogContent class="max-h-[85dvh] overflow-y-auto"
        ><DialogHeader class="sr-only"
          ><DialogTitle>Предложение заказа</DialogTitle
          ><DialogDescription
            >Примите заказ или скройте предложение.</DialogDescription
          ></DialogHeader
        ><IncomingOrder embedded />
        <p v-if="state.error" role="alert" class="text-sm text-destructive">
          {{ state.error }}
        </p></DialogContent
      ></Dialog
    >
    <Dialog v-model:open="tripOpen"
      ><DialogContent class="max-h-[85dvh] overflow-y-auto"
        ><DialogHeader class="sr-only"
          ><DialogTitle>Управление поездкой</DialogTitle
          ><DialogDescription
            >Свяжитесь с клиентом и отмечайте этапы поездки.</DialogDescription
          ></DialogHeader
        ><ActiveTrip v-if="!shiftElsewhere" embedded />
        <p v-if="state.error" role="alert" class="text-sm text-destructive">
          {{ state.error }}
        </p></DialogContent
      ></Dialog
    >
  </div>
</template>
<style scoped>
.online-beacon {
  animation: online-beacon 2.8s ease-out infinite;
}
@keyframes online-beacon {
  0% {
    opacity: 0.6;
    transform: scale(1);
  }
  60%,
  100% {
    opacity: 0;
    transform: scale(1.22);
  }
}
.availability-pulse {
  animation: availability-confirm 480ms ease-out both;
}
@keyframes availability-confirm {
  from {
    opacity: 0.7;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(1.25);
  }
}
@media (prefers-reduced-motion: reduce) {
  .online-beacon,
  .availability-pulse {
    animation: none;
    display: none;
  }
}

.region-grid {
  max-height: 24rem;
  grid-template-rows: repeat(var(--region-rows), minmax(0, 1fr));
}
.region-grid-with-trip > button {
  min-height: 44px;
  padding: 4px;
  gap: 2px;
}
.region-grid-with-trip .region-score {
  font-size: 1.125rem;
  line-height: 1;
}
.region-grid-with-trip .region-name {
  font-size: 0.75rem;
  line-height: 1.1;
}
@media (max-height: 650px) {
  .driver-home {
    gap: 0.375rem;
  }
  .region-name {
    font-size: 12px;
  }
  .region-grid-with-trip .region-name {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
  }
}
@media (orientation: landscape) and (max-height: 500px) {
  .driver-controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-items: center;
  }
  .region-grid > button {
    padding: 4px;
    gap: 2px;
  }
  .region-name {
    font-size: 11px;
    line-height: 1.1;
  }
  .region-score {
    font-size: 18px;
  }
  .region-grid-with-trip .region-name {
    display: block;
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .region-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
    grid-template-rows: repeat(var(--region-wide-rows), minmax(0, 1fr));
  }
}
</style>
