<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-slate-800 dark:bg-slate-950">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
        <div>
          <h1 class="text-lg font-semibold">Главная</h1>
          <p class="text-xs text-slate-500 dark:text-slate-500">Обзор Tayyn Hyzmat</p>
        </div>
        <AdminThemeToggle class="md:hidden" />
      </div>
    </header>

    <main class="mx-auto max-w-5xl space-y-4 px-4 py-4 pb-safe-mobile-nav sm:px-6">
      <div v-if="loading" class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div v-for="n in 8" :key="n" class="h-24 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-900" />
      </div>

      <p v-else-if="error" class="rounded-2xl border border-red-500 border-opacity-30 bg-red-500 bg-opacity-10 px-4 py-3 text-sm text-red-600 dark:text-red-400">{{ error }}</p>

      <template v-else>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard label="Водителей всего" :value="stats.driversTotal" accent="indigo" :icon="ICONS.drivers" />
          <StatCard label="Online сейчас" :value="stats.driversOnline" accent="brand" :icon="ICONS.online" />
          <StatCard label="На проверке" :value="stats.driversPending" accent="amber" :icon="ICONS.pending" />
          <StatCard label="Заблокировано" :value="stats.driversBlocked" accent="red" :icon="ICONS.blocked" />
          <StatCard label="Активные заказы" :value="stats.ordersActive" accent="indigo" :icon="ICONS.orders" />
          <StatCard label="Завершено всего" :value="stats.ordersCompleted" accent="brand" :icon="ICONS.done" />
          <StatCard label="Выручка" :value="`${formattedRevenue} TMT`" accent="brand" :icon="ICONS.money" wide />
          <StatCard label="Средний чек" :value="`${formattedAvgPrice} TMT`" accent="indigo" :icon="ICONS.avg" wide />
        </div>

        <section>
          <h2 class="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">Разделы</h2>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <router-link
              v-for="link in links"
              :key="link.to"
              :to="link.to"
              class="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 transition-colors duration-150 hover:border-indigo-500 dark:border-slate-800 dark:bg-slate-900"
            >
              <span class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-500 bg-opacity-10 text-indigo-600 dark:text-indigo-400">
                <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5" v-html="link.icon" />
              </span>
              <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ link.label }}</span>
            </router-link>
          </div>
        </section>
      </template>
    </main>

    <AdminNav />
  </div>
</template>

<script>
import adminApiClient from '@/services/adminApiClient'
import AdminNav from './components/AdminNav.vue'
import AdminThemeToggle from './components/AdminThemeToggle.vue'
import StatCard from './components/StatCard.vue'

const ICONS = {
  drivers: '<path d="M5 20v-1.5A3.5 3.5 0 0 1 8.5 15h7a3.5 3.5 0 0 1 3.5 3.5V20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="8" r="3.5" stroke="currentColor" stroke-width="1.8"/>',
  online: '<circle cx="12" cy="12" r="4" fill="currentColor"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/>',
  pending: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  blocked: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="m7 7 10 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  orders: '<rect x="4.5" y="5" width="15" height="15" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 3.5v3M15.5 3.5v3M4.5 10h15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  done: '<path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  money: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.4" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 9.5h19" stroke="currentColor" stroke-width="1.6"/><circle cx="17.5" cy="14" r="1.3" fill="currentColor"/>',
  avg: '<path d="M4 18V9M10 18V5M16 18v-7M20 18H4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  map: '<path d="M9 4.5 4.5 6v13.5L9 18l6 1.5 4.5-1.5V4.5L15 6 9 4.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 4.5V18M15 6v13.5" stroke="currentColor" stroke-width="1.8"/>',
  districts: '<rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="4" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="4" y="13" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="13" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/>',
  chat: '<path d="M4.5 6.5A2 2 0 0 1 6.5 4.5h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3.5V16.5H6.5a2 2 0 0 1-2-2v-8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  report:
    '<path d="M4 18V9M10 18V5M16 18v-7M20 18H4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
}

export default {
  name: 'AdminDashboard',
  components: { StatCard, AdminNav, AdminThemeToggle },
  data() {
    return {
      loading: true,
      error: '',
      ICONS,
      stats: {
        driversTotal: 0,
        driversOnline: 0,
        driversPending: 0,
        driversBlocked: 0,
        ordersActive: 0,
        ordersCompleted: 0,
        revenue: 0,
        avgPrice: 0
      },
      links: [
        { to: '/adminOrders', label: 'Заказы', icon: ICONS.orders },
        { to: '/adminDrivers', label: 'Водители', icon: ICONS.drivers },
        { to: '/adminMonitoring', label: 'Карта водителей', icon: ICONS.map },
        { to: '/adminDistricts', label: 'Районы', icon: ICONS.districts },
        { to: '/adminChat', label: 'Чат', icon: ICONS.chat },
        { to: '/adminReports', label: 'Отчёт активности', icon: ICONS.report }
      ]
    }
  },
  computed: {
    formattedRevenue() {
      return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(this.stats.revenue)
    },
    formattedAvgPrice() {
      return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(this.stats.avgPrice)
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
        // Deliberately local fetches (not the shared adminDrivers/adminOrders
        // Vuex modules) - those hold whatever filter the Водители/Заказы
        // tabs last set, and reusing them here would stomp that state.
        // limit is capped at 100 by GET /admin/drivers|orders themselves
        // (listDriversQuerySchema / listOrdersQuerySchema both cap at 100) -
        // asking for more just 400s the whole request.
        const [driversRes, activeOrdersRes, completedOrdersRes] = await Promise.all([
          adminApiClient.get('/admin/drivers', { params: { limit: 100 } }),
          adminApiClient.get('/admin/orders', { params: { status: 'active', limit: 1 } }),
          // Real revenue/average-check reporting, computed from actually
          // completed orders (not invented numbers) - capped at 100 rows for
          // one request; see the comment below for what that caps.
          adminApiClient.get('/admin/orders', { params: { status: 'completed', limit: 100 } })
        ])

        const drivers = driversRes.data.items
        const completedOrders = completedOrdersRes.data.items
        const revenue = completedOrders.reduce((sum, o) => sum + Number(o.priceFinal || o.priceEstimated || 0), 0)

        this.stats = {
          driversTotal: driversRes.data.total,
          driversOnline: drivers.filter((d) => d.isOnline).length,
          driversPending: drivers.filter((d) => d.status === 'PENDING').length,
          driversBlocked: drivers.filter((d) => d.status === 'BLOCKED').length,
          ordersActive: activeOrdersRes.data.total,
          // "Завершено всего" is capped by the 100-row page above once a
          // deployment has more completed trips than that - the number then
          // reads as "completed (last 100)" rather than a true lifetime
          // total; a dedicated backend count endpoint would remove the cap,
          // but doesn't exist yet and this task is frontend-only.
          ordersCompleted: completedOrdersRes.data.total,
          revenue,
          avgPrice: completedOrders.length ? revenue / completedOrders.length : 0
        }
      } catch (err) {
        this.error = (err.response && err.response.data && err.response.data.message) || 'Не удалось загрузить статистику'
      } finally {
        this.loading = false
      }
    }
  }
}
</script>
