<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-slate-800 dark:bg-slate-950">
      <div class="mx-auto max-w-5xl px-4 py-4 sm:px-6">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h1 class="text-lg font-semibold">Заказы</h1>
            <p class="text-xs text-slate-500">{{ total }} в этой вкладке</p>
          </div>
          <div class="flex flex-shrink-0 items-center gap-2">
            <AdminThemeToggle class="md:hidden" />
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition-colors duration-150 hover:bg-indigo-500"
              @click="showCreate = true"
            >
              <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
              Новый заказ
            </button>
          </div>
        </div>

        <div class="mt-3 flex gap-1 overflow-x-auto">
          <button
            v-for="f in filters"
            :key="f.value"
            type="button"
            class="flex-shrink-0 rounded-xl px-3 py-2 text-xs font-medium transition-colors duration-150"
            :class="statusFilter === f.value ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500 hover:text-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-slate-200'"
            @click="setFilter(f.value)"
          >
            {{ f.label }}
          </button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl space-y-2 px-4 py-4 pb-safe-mobile-nav sm:px-6">
      <div v-if="loading && !items.length" class="space-y-2">
        <div v-for="n in 5" :key="n" class="h-24 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-900" />
      </div>

      <p v-else-if="!items.length" class="py-10 text-center text-sm text-slate-500">Заказов нет</p>

      <div
        v-for="order in items"
        :key="order.id"
        class="rounded-2xl border border-slate-200 bg-white p-3 transition-colors duration-150 hover:border-indigo-400 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-500"
      >
        <router-link :to="order.driver ? `/adminDrivers/${order.driver.id}` : '#'" class="block">
          <div class="flex items-center justify-between">
            <OrderStatusBadge :status="order.status" />
            <p class="text-sm font-semibold tabular-nums">{{ order.priceFinal || order.priceEstimated || 0 }} TMT</p>
          </div>
          <p class="mt-1 truncate text-sm font-medium text-slate-700 dark:text-slate-200">{{ order.pickupAddress || '—' }} → {{ order.dropoffAddress || 'не указано' }}</p>
          <p v-if="order.note" class="mt-0.5 truncate text-xs text-amber-700 dark:text-amber-400">📝 {{ order.note }}</p>
          <div class="mt-1 flex items-center justify-between text-xs text-slate-500">
            <span>{{ order.driver ? order.driver.user.fullName : 'Не назначен' }} · {{ order.district ? order.district.name : '—' }}</span>
            <span>{{ formatDate(order.createdAt) }}</span>
          </div>
        </router-link>

        <div v-if="isCancellable(order.status)" class="mt-2 border-t border-slate-100 pt-2 dark:border-slate-800">
          <transition name="fade" mode="out-in">
            <button
              v-if="confirmingCancelId !== order.id"
              key="btn"
              type="button"
              class="text-xs font-medium text-red-500 transition-colors duration-150 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
              @click="confirmingCancelId = order.id"
            >
              Отменить заказ
            </button>
            <div v-else key="confirm" class="flex items-center gap-2">
              <span class="text-xs text-slate-500">Точно отменить?</span>
              <button
                type="button"
                class="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                :disabled="cancelling === order.id"
                @click="cancelOrder(order)"
              >
                {{ cancelling === order.id ? 'Отменяем…' : 'Да, отменить' }}
              </button>
              <button type="button" class="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300" @click="confirmingCancelId = null">
                Нет
              </button>
            </div>
          </transition>
        </div>
      </div>
    </main>

    <CreateOrderModal v-if="showCreate" @close="showCreate = false" @created="onCreated" />

    <AdminNav />
  </div>
</template>

<script>
import OrderStatusBadge from './components/OrderStatusBadge.vue'
import CreateOrderModal from './components/CreateOrderModal.vue'
import AdminNav from './components/AdminNav.vue'
import AdminThemeToggle from './components/AdminThemeToggle.vue'

const FILTERS = [
  { value: 'active', label: 'Активные' },
  { value: 'accepted', label: 'Принятые' },
  { value: 'completed', label: 'Завершённые' },
  { value: 'cancelled', label: 'Отменённые' },
  { value: 'all', label: 'Все' }
]

const CANCELLABLE = ['NEW', 'ACCEPTED', 'WAITING', 'STARTED']

export default {
  name: 'AdminOrders',
  components: { OrderStatusBadge, CreateOrderModal, AdminNav, AdminThemeToggle },
  data() {
    return { filters: FILTERS, showCreate: false, confirmingCancelId: null, cancelling: null }
  },
  computed: {
    items() {
      return this.$store.state.adminOrders.items
    },
    total() {
      return this.$store.state.adminOrders.total
    },
    loading() {
      return this.$store.state.adminOrders.loading
    },
    statusFilter() {
      return this.$store.state.adminOrders.statusFilter
    }
  },
  mounted() {
    this.$store.dispatch('adminOrders/fetchList')
  },
  methods: {
    setFilter(value) {
      this.$store.dispatch('adminOrders/setStatusFilter', value)
    },
    onCreated() {
      // adminOrders/createOrder already applies the new order into the
      // store itself (same applyOrderEvent path the order:new socket event
      // uses) - nothing to refetch here.
    },
    isCancellable(status) {
      return CANCELLABLE.includes(status)
    },
    async cancelOrder(order) {
      this.cancelling = order.id
      try {
        await this.$store.dispatch('adminOrders/cancelOrder', { orderId: order.id, reason: 'Отменено администратором' })
        this.$store.dispatch('ui/pushToast', { title: 'Заказ отменён', body: '', variant: 'default' })
      } catch (err) {
        const message = (err.response && err.response.data && err.response.data.message) || 'Не удалось отменить заказ'
        this.$store.dispatch('ui/pushToast', { title: 'Ошибка', body: message, variant: 'error' })
      } finally {
        this.cancelling = null
        this.confirmingCancelId = null
      }
    },
    formatDate(value) {
      return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
  }
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter,
.fade-leave-to {
  opacity: 0;
}
</style>
