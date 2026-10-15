<template>
  <transition name="modal-fade" appear>
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-black bg-opacity-70 backdrop-blur-sm sm:items-center">
      <div class="w-full max-w-sm animate-scale-in rounded-t-3xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-ink-600 dark:bg-ink-900 sm:rounded-3xl">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-bold text-slate-900 dark:text-white">Новый заказ</h2>
          <span class="rounded-full bg-brand-500 bg-opacity-10 px-3 py-1 text-xs font-semibold tabular-nums text-brand-700 dark:text-brand-400">
            Только вручную
          </span>
        </div>

        <div class="mt-4 space-y-3">
          <div class="flex gap-3">
            <div class="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand-500 bg-opacity-10 text-brand-600 dark:text-brand-400">
              <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5"><circle cx="12" cy="12" r="5" fill="currentColor" /></svg>
            </div>
            <div class="min-w-0">
              <p class="text-sm text-slate-500">Откуда</p>
              <p class="truncate text-base font-semibold text-slate-900 dark:text-slate-100">{{ order.pickupAddress || 'Адрес не указан' }}</p>
            </div>
          </div>

          <div class="flex gap-3">
            <div class="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-red-500 bg-opacity-10 text-red-600 dark:text-red-400">
              <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" /></svg>
            </div>
            <div class="min-w-0">
              <p class="text-sm text-slate-500">Куда</p>
              <p class="truncate text-base font-semibold text-slate-900 dark:text-slate-100">{{ order.dropoffAddress || 'Адрес не указан' }}</p>
            </div>
          </div>
        </div>

        <div class="mt-4 flex items-stretch gap-2">
          <div class="flex-1 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-center dark:border-ink-600 dark:bg-ink-800">
            <p class="text-xs text-slate-500">Стоимость</p>
            <p class="text-xl font-bold tabular-nums text-slate-900 dark:text-white">{{ formattedPrice }} TMT</p>
          </div>
          <div v-if="distanceKm !== null" class="flex-1 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-center dark:border-ink-600 dark:bg-ink-800">
            <p class="text-xs text-slate-500">Расстояние</p>
            <p class="text-xl font-bold tabular-nums text-slate-900 dark:text-white">≈{{ distanceKm }} км</p>
          </div>
        </div>

        <div v-if="order.note" class="mt-3 rounded-2xl border border-amber-500 border-opacity-20 bg-amber-500 bg-opacity-10 p-3">
          <p class="text-xs font-medium text-amber-700 dark:text-amber-400">Примечание</p>
          <p class="mt-0.5 whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">{{ order.note }}</p>
        </div>

        <p class="mt-4 text-center text-xs font-medium text-slate-500">Принять через:</p>
        <div class="mt-2 grid grid-cols-4 gap-2">
          <button
            v-for="minutes in etaOptions"
            :key="minutes"
            type="button"
            class="rounded-xl border py-3 text-sm font-semibold transition-all duration-150 active:scale-95 disabled:opacity-50"
            :class="selectedEta === minutes ? 'border-brand-500 bg-brand-500 bg-opacity-10 text-brand-700 dark:text-brand-400' : 'border-slate-200 text-slate-600 hover:border-brand-500 hover:border-opacity-50 dark:border-ink-600 dark:text-slate-300'"
            :disabled="busy"
            @click="selectedEta = minutes"
          >
            {{ minutes }}
            <span class="block text-xs font-normal opacity-70">мин</span>
          </button>
        </div>

        <div class="mt-4 flex gap-2">
          <button
            type="button"
            class="flex-shrink-0 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-500 transition-colors duration-150 hover:bg-slate-100 disabled:opacity-50 dark:border-ink-600 dark:text-slate-400 dark:hover:bg-ink-800"
            :disabled="busy"
            @click="decline"
          >
            Отказаться
          </button>
          <button
            type="button"
            class="flex-1 rounded-2xl bg-brand-600 py-3 text-sm font-semibold text-white transition-all duration-150 hover:bg-brand-500 active:scale-95 disabled:opacity-60"
            :disabled="busy"
            @click="accept"
          >
            Принять заказ
          </button>
        </div>

        <p v-if="error" class="mt-3 text-center text-xs text-red-600 dark:text-red-400">{{ error }}</p>
      </div>
    </div>
  </transition>
</template>

<script>
// Straight-line (haversine) estimate from the pickup/dropoff coordinates
// already in the order payload - the backend only knows the real driven
// distance after the trip is completed (see backend orders.service.js
// calculateDistanceKm), so this is a client-side "as the crow flies"
// approximation for display only, never sent anywhere or trusted for billing.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

export default {
  name: 'NewOrderModal',
  props: {
    order: { type: Object, required: true }
  },
  data() {
    return {
      etaOptions: [5, 10, 15, 20],
      selectedEta: 10
    }
  },
  computed: {
    busy() {
      return this.$store.state.order.busy
    },
    error() {
      return this.$store.state.order.error
    },
    formattedPrice() {
      const amount = Number(this.order.priceEstimated || 0)
      return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount)
    },
    distanceKm() {
      const { pickupLat, pickupLng, dropoffLat, dropoffLng } = this.order
      if (pickupLat == null || pickupLng == null || dropoffLat == null || dropoffLng == null) return null
      const km = haversineKm(Number(pickupLat), Number(pickupLng), Number(dropoffLat), Number(dropoffLng))
      return km.toFixed(1)
    }
  },
  methods: {
    accept() {
      this.$store.dispatch('order/accept', { orderId: this.order.id, etaMinutes: this.selectedEta })
    },
    decline() {
      this.$store.dispatch('order/dismissIncoming')
    }
  }
}
</script>

<style scoped>
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.2s ease;
}
.modal-fade-enter,
.modal-fade-leave-to {
  opacity: 0;
}
</style>
