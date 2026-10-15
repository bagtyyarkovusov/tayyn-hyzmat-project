<template>
  <section class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-ink-600 dark:bg-ink-800">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold text-slate-700 dark:text-slate-200">История</h2>
      <div class="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-ink-900">
        <button
          v-for="t in tabs"
          :key="t.value"
          type="button"
          class="rounded-lg px-3 py-1 text-xs font-medium transition-colors duration-150"
          :class="tab === t.value ? 'bg-white text-slate-900 shadow dark:bg-ink-700 dark:text-white' : 'text-slate-500'"
          @click="tab = t.value"
        >
          {{ t.label }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="mt-3 space-y-2">
      <div v-for="n in 3" :key="n" class="h-12 animate-pulse rounded-xl bg-slate-100 dark:bg-ink-900" />
    </div>

    <p v-else-if="error" class="mt-4 text-center text-sm text-red-600 dark:text-red-400">{{ error }}</p>

    <!-- Поездки -->
    <template v-else-if="tab === 'orders'">
      <p v-if="!orders.length" class="mt-4 text-center text-sm text-slate-500">Поездок пока нет</p>
      <div v-else class="mt-3 space-y-2">
        <div v-for="order in orders" :key="order.id" class="rounded-xl border border-slate-200 p-3 dark:border-ink-600">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {{ order.pickupAddress || 'Адрес не указан' }}
              </p>
              <p v-if="order.dropoffAddress" class="truncate text-xs text-slate-500">→ {{ order.dropoffAddress }}</p>
            </div>
            <p class="flex-shrink-0 text-sm font-bold tabular-nums text-slate-900 dark:text-white">
              {{ formatAmount(order.priceFinal || order.priceEstimated) }} TMT
            </p>
          </div>
          <div class="mt-1.5 flex items-center justify-between gap-2 text-xs">
            <span class="rounded-full px-2 py-0.5 font-medium" :class="statusMeta(order.status).class">
              {{ statusMeta(order.status).label }}
            </span>
            <span class="text-slate-500">{{ formatDate(order.createdAt) }}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- Баланс -->
    <template v-else>
      <p v-if="!transactions.length" class="mt-4 text-center text-sm text-slate-500">Операций пока нет</p>
      <div v-else class="mt-3 space-y-2">
        <div v-for="tx in transactions" :key="tx.id" class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-ink-600">
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{{ transactionLabel(tx.type) }}</p>
            <p class="text-xs text-slate-500">{{ formatDate(tx.createdAt) }}</p>
          </div>
          <div class="flex-shrink-0 text-right">
            <p class="text-sm font-bold tabular-nums" :class="Number(tx.amount) < 0 ? 'text-red-600 dark:text-red-400' : 'text-brand-600 dark:text-brand-400'">
              {{ Number(tx.amount) > 0 ? '+' : '' }}{{ formatAmount(tx.amount) }}
            </p>
            <p class="text-xs text-slate-500 tabular-nums">{{ formatAmount(tx.balanceAfter) }} TMT</p>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<script>
import apiClient from '@/services/apiClient'

// Same labels the admin panel uses for the same enum (see
// admin/AdminDriverDetail.vue) - a driver seeing "PAYMENT" would be
// meaningless.
const TRANSACTION_TYPE_LABELS = {
  TOPUP: 'Пополнение',
  EARNING: 'Начисление',
  COMMISSION: 'Комиссия',
  PAYMENT: 'Оплата поездки',
  WITHDRAWAL: 'Списание',
  REFUND: 'Возврат',
  BONUS: 'Бонус',
  ADJUSTMENT: 'Корректировка'
}

const ORDER_STATUS_META = {
  NEW: { label: 'Новый', class: 'bg-slate-100 text-slate-600 dark:bg-ink-900 dark:text-slate-300' },
  ACCEPTED: { label: 'Принят', class: 'bg-sky-500 bg-opacity-10 text-sky-700 dark:text-sky-400' },
  WAITING: { label: 'Ожидание', class: 'bg-amber-500 bg-opacity-10 text-amber-700 dark:text-amber-400' },
  STARTED: { label: 'В пути', class: 'bg-brand-500 bg-opacity-10 text-brand-700 dark:text-brand-400' },
  COMPLETED: { label: 'Завершён', class: 'bg-brand-500 bg-opacity-10 text-brand-700 dark:text-brand-400' },
  CANCELLED: { label: 'Отменён', class: 'bg-red-500 bg-opacity-10 text-red-700 dark:text-red-400' }
}

export default {
  name: 'HistoryCard',
  data() {
    return {
      tab: 'orders',
      tabs: [
        { value: 'orders', label: 'Поездки' },
        { value: 'balance', label: 'Баланс' }
      ],
      orders: [],
      transactions: [],
      loading: true,
      error: ''
    }
  },
  mounted() {
    this.load()
  },
  methods: {
    async load() {
      this.loading = true
      this.error = ''
      try {
        // GET /driver/history - the driver's own trips + balance movements,
        // scoped server-side to the authenticated driver (see backend
        // driver.service.js#getHistory).
        const { data } = await apiClient.get('/driver/history', { params: { limit: 50 } })
        this.orders = data.orders.items
        this.transactions = data.transactions.items
      } catch (err) {
        this.error = 'Не удалось загрузить историю'
      } finally {
        this.loading = false
      }
    },
    statusMeta(status) {
      return ORDER_STATUS_META[status] || { label: status, class: 'bg-slate-100 text-slate-600 dark:bg-ink-900 dark:text-slate-300' }
    },
    transactionLabel(type) {
      return TRANSACTION_TYPE_LABELS[type] || type
    },
    formatAmount(value) {
      return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(value || 0))
    },
    formatDate(value) {
      return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
  }
}
</script>
