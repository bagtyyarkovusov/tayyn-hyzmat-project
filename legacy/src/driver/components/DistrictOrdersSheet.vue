<template>
  <transition name="modal-fade" appear>
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-black bg-opacity-70 backdrop-blur-sm sm:items-center" @click.self="$emit('close')">
      <div class="flex max-h-90vh w-full max-w-sm flex-col animate-scale-in rounded-t-3xl border border-slate-200 bg-white shadow-2xl dark:border-ink-600 dark:bg-ink-900 sm:rounded-3xl">
        <div class="flex flex-shrink-0 items-start justify-between p-5 pb-3">
          <div class="min-w-0">
            <h2 class="truncate text-lg font-bold text-slate-900 dark:text-white">{{ district.name }}</h2>
            <!-- Any district is acceptable now, not just the driver's own
                 (reversed an earlier restriction by explicit request - see
                 backend orders.service.js#accept). Read-only only remains
                 while there's already an active order - a driver can still
                 only work one ride at a time. -->
            <p v-if="readOnlyReason" class="mt-0.5 text-xs text-slate-500">{{ readOnlyReason }}</p>
          </div>
          <button
            type="button"
            class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-ink-800"
            @click="$emit('close')"
          >
            <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <div v-if="loading" class="space-y-2">
            <div v-for="n in 3" :key="n" class="h-20 animate-pulse rounded-2xl bg-slate-100 dark:bg-ink-800" />
          </div>
          <p v-else-if="loadError" class="py-8 text-center text-sm text-red-600 dark:text-red-400">{{ loadError }}</p>
          <p v-else-if="!orders.length" class="py-8 text-center text-sm text-slate-500">Свободных заказов в этом районе пока нет</p>
          <div v-else class="space-y-2">
            <div v-for="order in orders" :key="order.id" class="rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-ink-600 dark:bg-ink-800">
              <div class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                  <p class="text-xs text-slate-500">Откуда</p>
                  <p class="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{{ order.pickupAddress || 'Адрес не указан' }}</p>
                  <p v-if="order.dropoffAddress" class="mt-1 truncate text-xs text-slate-500">→ {{ order.dropoffAddress }}</p>
                  <p v-if="order.note" class="mt-1 truncate text-xs text-amber-700 dark:text-amber-400">📝 {{ order.note }}</p>
                </div>
                <div class="flex-shrink-0 text-right">
                  <p class="text-xs text-slate-500">Стоимость</p>
                  <p class="text-sm font-bold tabular-nums text-slate-900 dark:text-white">{{ formatPrice(order.priceEstimated) }} TMT</p>
                </div>
              </div>
              <template v-if="canAccept">
                <!-- Same 5/10/15/20 choice as the "Новый заказ" popup
                     (NewOrderModal.vue) - this used to silently always send
                     10 with no way to pick, the only accept path that
                     didn't offer a choice. -->
                <div class="mt-2 grid grid-cols-4 gap-1.5">
                  <button
                    v-for="minutes in etaOptions"
                    :key="minutes"
                    type="button"
                    class="rounded-lg border py-1.5 text-xs font-semibold transition-all duration-150 active:scale-95"
                    :class="etaFor(order.id) === minutes ? 'border-brand-500 bg-brand-500 bg-opacity-10 text-brand-700 dark:text-brand-400' : 'border-slate-200 text-slate-600 dark:border-ink-600 dark:text-slate-300'"
                    @click="setEta(order.id, minutes)"
                  >
                    {{ minutes }} мин
                  </button>
                </div>
                <button
                  type="button"
                  class="mt-1.5 w-full rounded-xl bg-brand-600 py-2 text-sm font-semibold text-white transition-all duration-150 hover:bg-brand-500 active:scale-95 disabled:opacity-60"
                  :disabled="acceptingId === order.id"
                  @click="accept(order)"
                >
                  {{ acceptingId === order.id ? 'Принимаем…' : 'Принять' }}
                </button>
              </template>
            </div>
          </div>
          <p v-if="acceptError" class="mt-3 text-center text-xs text-red-600 dark:text-red-400">{{ acceptError }}</p>
        </div>
      </div>
    </div>
  </transition>
</template>

<script>
import apiClient from '@/services/apiClient'

export default {
  name: 'DistrictOrdersSheet',
  props: {
    district: { type: Object, required: true } // { id, name }
  },
  data() {
    return {
      orders: [],
      loading: true,
      loadError: '',
      acceptingId: null,
      etaOptions: [5, 10, 15, 20],
      etaSelections: {} // orderId -> minutes, defaults to 10 (see etaFor)
    }
  },
  computed: {
    acceptError() {
      return this.$store.state.order.error
    },
    // A driver can only ever have one order in progress - same rule
    // accept() enforces server-side (orders.service.js), surfaced here so
    // the button's absence has a visible reason instead of just not being
    // there.
    hasActiveOrder() {
      return Boolean(this.$store.state.order.active)
    },
    canAccept() {
      return !this.hasActiveOrder
    },
    readOnlyReason() {
      if (this.hasActiveOrder) return 'У вас уже есть активный заказ — сначала завершите его'
      return ''
    }
  },
  mounted() {
    this.load()
  },
  methods: {
    async load() {
      this.loading = true
      this.loadError = ''
      try {
        const { data } = await apiClient.get('/orders/available', { params: { districtId: this.district.id } })
        this.orders = data
      } catch (err) {
        this.loadError = 'Не удалось загрузить заказы'
      } finally {
        this.loading = false
      }
    },
    formatPrice(amount) {
      return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(amount || 0))
    },
    etaFor(orderId) {
      return this.etaSelections[orderId] || 10
    },
    setEta(orderId, minutes) {
      this.$set(this.etaSelections, orderId, minutes)
    },
    // Reuses order/accept - the same action NewOrderModal.vue's "Принять
    // заказ" button dispatches, so accepting from here becomes the driver's
    // active order exactly the same way (ActiveOrderPanel takes over via
    // OrderOverlay.vue). order/accept deliberately swallows a 409 (someone
    // else got there first) without setting error - the NewOrderModal popup
    // can just quietly disappear on that, but here the driver explicitly
    // tapped this order, so check that it actually became the active order
    // rather than trusting the (possibly empty) error state; refetch either
    // way it didn't so a stale, already-taken row can't be tapped again.
    async accept(order) {
      this.acceptingId = order.id
      await this.$store.dispatch('order/accept', { orderId: order.id, etaMinutes: this.etaFor(order.id) })
      this.acceptingId = null
      const active = this.$store.state.order.active
      if (active && active.id === order.id) {
        this.$emit('close')
      } else {
        this.load()
      }
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
