<template>
  <transition name="sheet" appear>
    <div class="fixed inset-x-0 bottom-0 z-40 md:pl-60">
      <div class="sheet-safe-bottom mx-auto max-w-md rounded-t-3xl border-t border-slate-200 bg-white p-5 shadow-2xl dark:border-ink-600 dark:bg-ink-900 sm:rounded-3xl">
        <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200 dark:bg-ink-600" />

        <div class="flex items-center justify-between gap-2">
          <span class="rounded-full px-2.5 py-1 text-xs font-semibold" :class="statusBadgeClass">{{ statusLabel }}</span>

          <a
            v-if="order.clientPhone"
            :href="'tel:' + order.clientPhone"
            class="flex items-center gap-1.5 rounded-xl bg-brand-500 bg-opacity-10 px-3 py-1.5 text-sm font-semibold text-brand-700 transition-colors duration-150 hover:bg-opacity-25 dark:text-brand-400"
          >
            <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4">
              <path
                d="M6.5 4.5h2.8l1.2 3.6-1.9 1.4a10.5 10.5 0 0 0 5.9 5.9l1.4-1.9 3.6 1.2v2.8a1.5 1.5 0 0 1-1.6 1.5A15 15 0 0 1 5 6.1a1.5 1.5 0 0 1 1.5-1.6Z"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linejoin="round"
              />
            </svg>
            {{ order.clientPhone }}
          </a>
        </div>

        <div class="mt-3">
          <p class="text-sm text-slate-500">{{ order.status === 'STARTED' ? 'Куда' : 'Откуда' }}</p>
          <p class="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
            {{ (order.status === 'STARTED' ? order.dropoffAddress : order.pickupAddress) || 'Адрес не указан' }}
          </p>
          <p class="mt-1 text-sm font-semibold tabular-nums text-slate-900 dark:text-white">{{ formattedPrice }} TMT</p>
        </div>

        <!-- Stays visible for the whole ride, not just the initial "Новый
             заказ" popup - a dispatcher's note ("клиент с собакой",
             "перезвонить") usually still matters after accepting. -->
        <p v-if="order.note" class="mt-2 rounded-xl bg-amber-500 bg-opacity-10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          📝 {{ order.note }}
        </p>

        <!-- Navigation hand-off. Opens MAPS.ME first (mapsme:// deep
             link); if it isn't installed nothing happens and the page stays
             visible, so a short timer falls through to Yandex Maps' public
             route URL instead. Both are plain app/web links - no API key or
             billing involved. Hidden entirely when the point to navigate to
             is missing, rather than sending a driver somewhere approximate. -->
        <button
          v-if="destination"
          type="button"
          class="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 py-3 text-slate-700 transition-colors duration-150 hover:bg-slate-100 dark:border-ink-600 dark:text-slate-200 dark:hover:bg-ink-800"
          :aria-label="order.status === 'STARTED' ? 'Маршрут до точки назначения' : 'Маршрут до клиента'"
          @click="openNavigation"
        >
          <svg viewBox="0 0 24 24" fill="none" class="h-6 w-6">
            <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            <circle cx="12" cy="9.5" r="2.6" stroke="currentColor" stroke-width="1.8" />
          </svg>
        </button>

        <p v-if="order.status === 'ACCEPTED'" class="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Ожидаемое прибытие: <span class="font-semibold text-slate-700 dark:text-slate-200">{{ order.etaMinutes }} мин</span>
        </p>

        <div v-if="order.status === 'WAITING'" class="mt-3 rounded-2xl border border-amber-500 border-opacity-20 bg-amber-500 bg-opacity-10 p-4 text-center">
          <p class="text-xs font-medium text-amber-700 dark:text-amber-400">Ожидание клиента</p>
          <p class="mt-0.5 text-3xl font-bold tabular-nums text-slate-900 dark:text-white">{{ waitTimerLabel }}</p>
        </div>

        <div v-if="order.status === 'STARTED'" class="mt-3 rounded-2xl border border-brand-500 border-opacity-20 bg-brand-500 bg-opacity-10 p-3 text-center">
          <p class="text-lg font-semibold tabular-nums text-slate-900 dark:text-white">{{ tripTimerLabel }}</p>
          <p class="mt-0.5 text-xs text-brand-700 dark:text-brand-400">Поездка в процессе</p>
        </div>

        <transition name="fade" mode="out-in">
          <div v-if="!confirmingCancel" key="actions" class="mt-4 flex gap-2">
            <button
              v-if="order.status === 'ACCEPTED'"
              type="button"
              class="flex-1 rounded-2xl bg-brand-600 py-3 text-sm font-semibold text-white transition-all duration-150 hover:bg-brand-500 active:scale-95 disabled:opacity-60"
              :disabled="busy"
              @click="markWaiting"
            >
              Я приехал
            </button>
            <button
              v-if="order.status === 'WAITING'"
              type="button"
              class="flex-1 rounded-2xl bg-brand-600 py-3 text-sm font-semibold text-white transition-all duration-150 hover:bg-brand-500 active:scale-95 disabled:opacity-60"
              :disabled="busy"
              @click="startTrip"
            >
              Начать поездку
            </button>
            <button
              v-if="order.status === 'STARTED'"
              type="button"
              class="flex-1 rounded-2xl bg-brand-600 py-3 text-sm font-semibold text-white transition-all duration-150 hover:bg-brand-500 active:scale-95 disabled:opacity-60"
              :disabled="busy"
              @click="complete"
            >
              Завершить заказ
            </button>
            <button
              v-if="['ACCEPTED', 'WAITING'].includes(order.status)"
              type="button"
              class="flex-shrink-0 rounded-2xl border border-red-500 border-opacity-30 px-4 py-3 text-sm font-medium text-red-600 transition-colors duration-150 hover:bg-red-500 hover:bg-opacity-10 dark:text-red-400"
              @click="confirmingCancel = true"
            >
              Отменить
            </button>
          </div>

          <div v-else key="confirm" class="mt-4 space-y-2">
            <p class="text-center text-sm text-slate-500 dark:text-slate-400">Отменить заказ?</p>
            <div class="flex gap-2">
              <button
                type="button"
                class="flex-1 rounded-2xl bg-red-600 py-2.5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-red-500"
                :disabled="busy"
                @click="cancel"
              >
                Да, отменить
              </button>
              <button
                type="button"
                class="flex-1 rounded-2xl border border-slate-200 py-2.5 text-sm font-medium text-slate-600 dark:border-ink-600 dark:text-slate-300"
                @click="confirmingCancel = false"
              >
                Нет
              </button>
            </div>
          </div>
        </transition>
      </div>
    </div>
  </transition>
</template>

<script>
const STATUS_META = {
  ACCEPTED: { label: 'Еду за пассажиром', class: 'bg-sky-500 bg-opacity-10 text-sky-700 dark:text-sky-400' },
  WAITING: { label: 'Ожидание', class: 'bg-amber-500 bg-opacity-10 text-amber-700 dark:text-amber-400' },
  STARTED: { label: 'В пути', class: 'bg-brand-500 bg-opacity-10 text-brand-700 dark:text-brand-400' }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export default {
  name: 'ActiveOrderPanel',
  props: {
    order: { type: Object, required: true }
  },
  data() {
    return {
      now: Date.now(),
      tickTimer: null,
      confirmingCancel: false
    }
  },
  computed: {
    busy() {
      return this.$store.state.order.busy
    },
    statusLabel() {
      return (STATUS_META[this.order.status] || {}).label || this.order.status
    },
    statusBadgeClass() {
      return (STATUS_META[this.order.status] || {}).class || ''
    },
    formattedPrice() {
      const amount = Number(this.order.priceEstimated || 0)
      return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount)
    },
    waitTimerLabel() {
      if (!this.order.arrivedAt) return '0:00'
      const elapsed = (this.now - new Date(this.order.arrivedAt).getTime()) / 1000
      return formatDuration(Math.max(0, elapsed))
    },
    tripTimerLabel() {
      if (!this.order.startedAt) return '0:00'
      const elapsed = (this.now - new Date(this.order.startedAt).getTime()) / 1000
      return formatDuration(Math.max(0, elapsed))
    },
    // STARTED means the passenger is already aboard - navigate to the
    // dropoff, if one was actually given (it's an optional field - see
    // backend orders.validation.js). Every other status means navigate to
    // the pickup, which is always present.
    destination() {
      const useDropoff = this.order.status === 'STARTED'
      const targetLat = useDropoff ? this.order.dropoffLat : this.order.pickupLat
      const targetLng = useDropoff ? this.order.dropoffLng : this.order.pickupLng
      if (targetLat == null || targetLng == null) return null
      return {
        lat: Number(targetLat),
        lng: Number(targetLng),
        label: useDropoff ? 'Точка назначения' : 'Клиент'
      }
    },
    // Live GPS from the store (locationReporter.js mirrors it there) - used
    // as the route's start point when available. MAPS.ME's route API wants
    // both ends, so without it we fall back to just showing the destination
    // pin, which MAPS.ME can then route from itself.
    currentPosition() {
      return this.$store.state.driverAuth.lastPosition
    },
    mapsMeUrl() {
      const d = this.destination
      if (!d) return null
      const from = this.currentPosition
      if (from && Number.isFinite(from.lat) && Number.isFinite(from.lng)) {
        return `mapsme://route?sll=${from.lat},${from.lng}&saddr=${encodeURIComponent('Я')}&dll=${d.lat},${d.lng}&daddr=${encodeURIComponent(d.label)}&type=vehicle`
      }
      return `mapsme://map?ll=${d.lat},${d.lng}&n=${encodeURIComponent(d.label)}&zoom=16`
    },
    yandexUrl() {
      const d = this.destination
      if (!d) return null
      return `https://yandex.ru/maps/?rtext=~${d.lat},${d.lng}&rtt=auto`
    }
  },
  watch: {
    'order.status'() {
      this.confirmingCancel = false
    }
  },
  mounted() {
    this.tickTimer = window.setInterval(() => {
      this.now = Date.now()
    }, 1000)
  },
  beforeDestroy() {
    window.clearInterval(this.tickTimer)
  },
  methods: {
    markWaiting() {
      this.$store.dispatch('order/markWaiting')
    },
    startTrip() {
      this.$store.dispatch('order/startTrip')
    },
    complete() {
      this.$store.dispatch('order/complete')
    },
    // MAPS.ME first. If it isn't installed the mapsme:// navigation is
    // simply ignored and this page never goes to the background, so the
    // timer still fires and we send them to Yandex Maps instead. If the app
    // DID open, the document is hidden by then and we leave it alone rather
    // than yanking a second map open behind it.
    openNavigation() {
      const fallback = this.yandexUrl
      if (!this.mapsMeUrl) return
      let switched = false
      const markSwitched = () => {
        switched = true
      }
      document.addEventListener('visibilitychange', markSwitched, { once: true })
      window.addEventListener('pagehide', markSwitched, { once: true })

      window.location.href = this.mapsMeUrl

      window.setTimeout(() => {
        document.removeEventListener('visibilitychange', markSwitched)
        window.removeEventListener('pagehide', markSwitched)
        if (switched || document.hidden || !fallback) return
        window.location.href = fallback
      }, 1500)
    },
    cancel() {
      this.$store.dispatch('order/cancel', 'Отменено водителем')
      this.confirmingCancel = false
    }
  }
}
</script>

<style scoped>
.sheet-enter-active,
.sheet-leave-active {
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
}
.sheet-enter,
.sheet-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter,
.fade-leave-to {
  opacity: 0;
}
</style>
