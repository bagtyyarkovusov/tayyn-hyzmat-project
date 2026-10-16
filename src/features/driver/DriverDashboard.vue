<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useDocumentVisibility, useOnline } from "@vueuse/core";
import {
  MapPin,
  LocateFixed,
  Power,
  Bell,
  BellRing,
  BellOff,
  Check,
  MapPinOff,
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
import { useDriverAddress } from "./useDriverAddress";
import { alertState, enableOrderAlerts, syncAlertPermission } from "./alerts";
import { nativeAndroid } from "./nativeShift";
import { money } from "./model";
import IncomingOrder from "./components/IncomingOrder.vue";
import DriverFeedback from "./components/DriverFeedback.vue";
import ActiveTripFeed from "./components/ActiveTripFeed.vue";
import ActiveTrip from "./components/ActiveTrip.vue";
import AvailableOrders from "./components/AvailableOrders.vue";
const {
  state,
  setOnline,
  enableGps,
  session,
  dismissIncoming,
  declinePrivateOffer,
} = useDriver();
const address = useDriverAddress(
  () => state.position,
  () => state.profile?.id,
  () => state.gpsReady,
);
function closeIncoming() {
  if (state.incoming?.privateOfferExpiresAt) void declinePrivateOffer();
  else dismissIncoming();
}
const selected = ref<string | null>(null);
const visibility = useDocumentVisibility();
const networkOnline = useOnline();
const connectionReady = computed(
  () =>
    networkOnline.value &&
    (nativeAndroid && state.profile?.isOnline
      ? state.nativeConnected
      : session.state.connected),
);
const localFixFresh = computed(
  () => state.gpsFixReady && state.clock - state.locationUpdatedAt < 60_000,
);
const locationReady = computed(
  () => localFixFresh.value && state.gpsReady && connectionReady.value,
);
const locationState = computed(() => {
  if (state.gpsPending) return "pending";
  if (!state.gpsFixReady && state.gpsError) return "blocked";
  if (locationReady.value) return "ready";
  if (state.gpsFixReady || state.locationSyncPending) return "connecting";
  return "inactive";
});
const liveOnline = computed(
  () => !!state.profile?.isOnline && locationReady.value,
);
const availabilityDescription = computed(() =>
  !state.profile?.isOnline
    ? "Не на линии."
    : !connectionReady.value
      ? "Нет связи с диспетчером. Переподключаемся."
      : !state.gpsReady
        ? "Нет актуального GPS."
        : "На линии. Связь с диспетчером установлена.",
);
const alertsReady = computed(
  () => alertState.permission === "granted" && alertState.soundReady,
);
const alertDescription = computed(() => {
  if (alertState.pending) return "Включаем уведомления и звук…";
  if (alertState.permission === "denied")
    return nativeAndroid
      ? "Разрешите уведомления о заказах и сообщениях в настройках приложения."
      : "Уведомления заблокированы. Разрешите их в настройках браузера.";
  if (alertState.permission === "unsupported")
    return "Системные уведомления недоступны в этом браузере.";
  if (alertState.permission === "granted")
    return alertState.soundReady
      ? "Уведомления разрешены. Звук включён."
      : "Уведомления разрешены. Нажмите, чтобы включить звук.";
  return "Нажмите, чтобы разрешить уведомления и включить звук.";
});
const gpsDescription = computed(() =>
  state.gpsPending
    ? "Получаем местоположение…"
    : locationReady.value
      ? "GPS и связь с диспетчером подтверждены."
      : state.gpsFixReady
        ? !localFixFresh.value
          ? "Последнее положение устарело. Нажмите GPS, чтобы обновить."
          : state.locationSyncError ||
            "GPS работает. Ожидаем связь с диспетчером…"
        : state.gpsError || "GPS не включён. Нажмите, чтобы включить.",
);
const lastLocationDescription = computed(() =>
  state.locationUpdatedAt
    ? new Date(state.locationUpdatedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "",
);
let permissionStatus: PermissionStatus | undefined;
let disposed = false;
onMounted(async () => {
  syncAlertPermission();
  window.addEventListener("focus", syncAlertPermission);
  try {
    const status = await navigator.permissions.query({ name: "notifications" });
    if (disposed) return;
    permissionStatus = status;
    status.addEventListener("change", syncAlertPermission);
  } catch {
    /* Some mobile browsers do not expose notification permission queries. */
  }
});
onUnmounted(() => {
  disposed = true;
  window.removeEventListener("focus", syncAlertPermission);
  permissionStatus?.removeEventListener("change", syncAlertPermission);
});
watch(visibility, () => {
  if (visibility.value === "visible") syncAlertPermission();
});
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
const ownRegion = computed(
  () =>
    state.districts.find((d) => d.id === state.profile?.districtId)?.name ||
    "Вне районов",
);
const blockers = computed(() => {
  const messages: string[] = [];
  if (!state.gpsFixReady)
    messages.push(
      state.gpsError ||
        (state.gpsPending
          ? "Получаем местоположение…"
          : "Включите GPS, чтобы принимать заказы."),
    );
  else if (state.profile?.isOnline && !locationReady.value)
    messages.push(gpsDescription.value);
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
          class="mr-auto text-sm font-semibold tabular-nums"
          aria-label="Баланс"
          >{{ state.balance ? money(state.balance.amount) : "…" }}</span
        >
        <div class="flex shrink-0 items-center gap-3">
          <div
            role="group"
            aria-label="Разрешения устройства"
            class="flex items-center rounded-full bg-secondary/60 px-1"
          >
            <Button
              variant="ghost"
              size="icon"
              class="relative size-11 rounded-full"
              :class="
                locationState === 'ready'
                  ? 'bg-success/10 text-success'
                  : locationState === 'blocked'
                    ? 'text-destructive'
                    : locationState === 'connecting' ||
                        locationState === 'pending'
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                      : 'text-muted-foreground'
              "
              :data-state="locationState"
              :aria-description="gpsDescription"
              :title="gpsDescription"
              :disabled="state.gpsPending"
              aria-label="Включить GPS"
              @click="enableGps"
            >
              <LoaderCircle
                v-if="state.gpsPending"
                class="size-5 motion-safe:animate-spin"
                aria-hidden="true"
              />
              <MapPinOff
                v-else-if="locationState === 'blocked'"
                class="size-5"
                aria-hidden="true"
              />
              <LocateFixed v-else class="size-5" aria-hidden="true" />
              <Check
                v-if="locationState === 'ready'"
                class="absolute bottom-1 right-1 size-3 rounded-full bg-background"
                aria-hidden="true"
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              class="relative size-11 rounded-full"
              :class="
                alertsReady
                  ? 'bg-success/10 text-success'
                  : alertState.permission === 'denied' ||
                      alertState.permission === 'unsupported'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
              "
              :data-state="
                alertState.pending
                  ? 'pending'
                  : alertsReady
                    ? 'ready'
                    : alertState.permission === 'denied' ||
                        alertState.permission === 'unsupported'
                      ? 'blocked'
                      : 'inactive'
              "
              :disabled="alertState.pending"
              :aria-description="alertDescription"
              :title="alertDescription"
              aria-label="Включить уведомления и звук"
              @click="enableOrderAlerts"
            >
              <LoaderCircle
                v-if="alertState.pending"
                class="size-5 motion-safe:animate-spin"
                aria-hidden="true"
              />
              <BellRing
                v-else-if="alertsReady"
                class="size-5"
                aria-hidden="true"
              />
              <BellOff
                v-else-if="
                  alertState.permission === 'denied' ||
                  alertState.permission === 'unsupported'
                "
                class="size-5"
                aria-hidden="true"
              />
              <Bell v-else class="size-5" aria-hidden="true" />
              <Check
                v-if="alertsReady"
                class="absolute bottom-1 right-1 size-3 rounded-full bg-background"
                aria-hidden="true"
              />
            </Button>
          </div>
          <Button
            variant="outline"
            class="relative size-11 shrink-0 overflow-visible rounded-full border shadow-none [&_svg]:size-5 motion-safe:transition-[background-color,border-color,color,transform] motion-safe:duration-200 active:scale-95"
            :class="
              state.profile?.isOnline
                ? liveOnline
                  ? 'border-emerald-300 bg-emerald-300 text-emerald-950 hover:bg-emerald-200 dark:border-emerald-400 dark:bg-emerald-400 dark:hover:bg-emerald-300'
                  : 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200'
                : 'border-red-200 bg-red-100 text-red-700 hover:bg-red-200 dark:border-red-800 dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-900'
            "
            :aria-label="
              state.profile?.isOnline ? 'Уйти с линии' : 'Выйти на линию'
            "
            :aria-description="availabilityDescription"
            :title="availabilityDescription"
            :aria-pressed="!!state.profile?.isOnline"
            :aria-describedby="
              !state.gpsFixReady ? 'driver-gps-blocker' : undefined
            "
            :aria-busy="state.busy"
            :disabled="
              state.busy ||
              state.locationSyncPending ||
              !state.profile ||
              (!state.profile.isOnline &&
                (Number(state.balance?.amount ?? 0) <= 0 || !localFixFresh))
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
      <span class="sr-only" role="status">{{ availabilityDescription }}</span>
      <div class="flex shrink-0 items-center justify-between gap-2">
        <div
          class="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-sm"
          aria-label="Местоположение GPS"
        >
          <MapPin class="size-4 shrink-0 text-primary" />
          <span class="flex min-w-0 flex-col leading-snug">
            <span class="truncate">{{
              locationReady
                ? ownRegion
                : state.position
                  ? "Последнее положение"
                  : "Ожидаем GPS"
            }}</span>
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
            <span
              v-if="!locationReady && lastLocationDescription"
              class="text-[11px] text-muted-foreground"
            >
              Последнее обновление {{ lastLocationDescription }}
            </span>
          </span>
        </div>
      </div>
      <DriverFeedback
        :blockers="state.active ? [] : blockers"
        :error="incomingOpen || tripOpen ? '' : state.error"
        :notice="state.notice"
        :attempt="state.actionAttempt"
      />
    </div>
    <ActiveTripFeed @details="tripOpen = true" />
    <p v-if="state.position && locationReady" class="sr-only" role="status">
      GPS · точность {{ Math.round(state.position.accuracy) }} м
    </p>
    <p
      v-if="state.profile?.isOnline && !connectionReady"
      role="status"
      class="shrink-0 text-xs text-amber-700 dark:text-amber-300"
    >
      Переподключаемся к диспетчеру…
    </p>
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
          d.activeOrders > 0
            ? 'border-emerald-300 bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900'
            : 'bg-card hover:bg-secondary/50',
          d.id === state.profile?.districtId ? 'ring-1 ring-primary' : '',
        ]"
        :disabled="!locationReady || !state.profile?.isOnline"
        @click="selected = d.id"
      >
        <span
          class="region-name break-words text-[13px] font-medium leading-tight"
          >{{ d.name
          }}<span v-if="d.id === state.profile?.districtId" class="sr-only">
            · Мой район</span
          ></span
        >
        <strong
          class="region-score text-2xl font-semibold leading-none tabular-nums"
          :aria-label="`Машин на линии: ${d.onlineDrivers ?? d.freeDrivers}. Заказов: ${d.activeOrders}`"
          >{{
            locationReady && state.profile?.isOnline
              ? `${d.onlineDrivers ?? d.freeDrivers}:${d.activeOrders}`
              : "—:—"
          }}</strong
        >
      </button>
    </div>
    <Dialog :open="!!selected" @update:open="!$event && (selected = null)"
      ><DialogContent
        class="queue-dialog flex max-h-[85dvh] flex-col overflow-hidden"
        ><DialogHeader class="shrink-0 pr-8"
          ><DialogTitle>Заказы района</DialogTitle
          ><DialogDescription
            >Выберите заказ и время прибытия.</DialogDescription
          ></DialogHeader
        >
        <AvailableOrders
          v-if="selectedDistrict && state.profile?.isOnline"
          v-show="locationReady"
          :district-id="selectedDistrict.id"
          :district-name="selectedDistrict.name"
        />
        <p v-if="!locationReady" class="muted text-sm">
          Включите GPS и выйдите на линию, чтобы принимать заказы.
        </p>
      </DialogContent></Dialog
    >
    <Dialog :open="incomingOpen" @update:open="!$event && closeIncoming()"
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
        ><ActiveTrip embedded />
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
}
.region-grid-with-trip .region-name {
  font-size: 0.75rem;
}
@media (max-height: 650px) {
  .driver-home {
    gap: 0.375rem;
  }
  .region-name {
    font-size: 12px;
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
  .region-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
    grid-template-rows: repeat(var(--region-wide-rows), minmax(0, 1fr));
  }
}
</style>
