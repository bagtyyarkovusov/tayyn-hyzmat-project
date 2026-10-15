<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-slate-800 dark:bg-slate-950">
      <div class="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
        <div>
          <h1 class="text-lg font-semibold">Отчёт активности</h1>
          <p class="text-xs text-slate-500">Кто и что делал в панели администратора</p>
        </div>
        <AdminThemeToggle class="md:hidden" />
      </div>
    </header>

    <main class="mx-auto max-w-3xl space-y-2 px-4 py-4 pb-safe-mobile-nav sm:px-6">
      <div v-if="loading" class="space-y-2">
        <div v-for="n in 6" :key="n" class="h-16 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-900" />
      </div>

      <p v-else-if="error" class="rounded-2xl border border-red-500 border-opacity-30 bg-red-500 bg-opacity-10 px-4 py-3 text-sm text-red-600 dark:text-red-400">{{ error }}</p>

      <p v-else-if="!items.length" class="py-10 text-center text-sm text-slate-500">Пока нет активности</p>

      <div
        v-for="event in items"
        :key="event.id"
        class="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
      >
        <span class="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl" :class="meta(event.type).class">
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" v-html="meta(event.type).icon" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-sm text-slate-800 dark:text-slate-200">{{ event.summary }}</p>
          <p class="mt-0.5 text-xs text-slate-500">
            {{ event.actor || 'Система' }} · {{ formatDate(event.at) }}
          </p>
        </div>
      </div>
    </main>

    <AdminNav />
  </div>
</template>

<script>
import adminApiClient from '@/services/adminApiClient'
import AdminNav from './components/AdminNav.vue'
import AdminThemeToggle from './components/AdminThemeToggle.vue'

const META = {
  driver_approved: {
    class: 'bg-emerald-500 bg-opacity-10 text-emerald-600 dark:text-emerald-400',
    icon: '<path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'
  },
  driver_blocked: {
    class: 'bg-red-500 bg-opacity-10 text-red-600 dark:text-red-400',
    icon: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="m7 7 10 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
  },
  balance_adjusted: {
    class: 'bg-indigo-500 bg-opacity-10 text-indigo-600 dark:text-indigo-400',
    icon: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.4" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 9.5h19" stroke="currentColor" stroke-width="1.6"/><circle cx="17.5" cy="14" r="1.3" fill="currentColor"/>'
  },
  order_cancelled: {
    class: 'bg-amber-500 bg-opacity-10 text-amber-600 dark:text-amber-400',
    icon: '<rect x="4.5" y="5" width="15" height="15" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="m9 15 6-6M9 9l6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
  }
}
const DEFAULT_META = { class: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400', icon: '<circle cx="12" cy="12" r="3" fill="currentColor"/>' }

export default {
  name: 'AdminReports',
  components: { AdminNav, AdminThemeToggle },
  data() {
    return { items: [], loading: true, error: '' }
  },
  mounted() {
    this.load()
  },
  methods: {
    meta(type) {
      return META[type] || DEFAULT_META
    },
    formatDate(value) {
      return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    },
    async load() {
      this.loading = true
      this.error = ''
      try {
        const { data } = await adminApiClient.get('/admin/activity', { params: { limit: 100 } })
        this.items = data.items
      } catch (err) {
        this.error = (err.response && err.response.data && err.response.data.message) || 'Не удалось загрузить отчёт'
      } finally {
        this.loading = false
      }
    }
  }
}
</script>
