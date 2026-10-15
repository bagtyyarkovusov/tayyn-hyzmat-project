<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-slate-800 dark:bg-slate-950">
      <div class="mx-auto max-w-5xl px-4 py-4 sm:px-6">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h1 class="text-lg font-semibold">Водители</h1>
            <p class="text-xs text-slate-500">{{ total }} всего · {{ onlineCount }} online</p>
          </div>
          <AdminThemeToggle class="md:hidden" />
        </div>

        <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div class="relative flex-1">
            <svg viewBox="0 0 24 24" fill="none" class="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8" />
              <path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
            <input
              v-model.trim="search"
              type="text"
              placeholder="Поиск по имени или телефону…"
              class="w-full rounded-2xl border border-slate-200 bg-white py-2.5 pl-10 pr-4 text-sm text-slate-900 outline-none transition-colors duration-150 placeholder:text-slate-400 focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
          </div>

          <div class="flex gap-1 overflow-x-auto">
            <button
              v-for="filter in filters"
              :key="filter.value"
              type="button"
              class="flex-shrink-0 rounded-xl px-3 py-2 text-xs font-medium transition-colors duration-150"
              :class="statusFilter === filter.value ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500 hover:text-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-slate-200'"
              @click="setFilter(filter.value)"
            >
              {{ filter.label }}
            </button>
          </div>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl space-y-2 px-4 py-4 pb-safe-mobile-nav sm:px-6">
      <div v-if="loading && !items.length" class="space-y-2">
        <div v-for="n in 5" :key="n" class="h-20 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-900" />
      </div>

      <p v-else-if="!filteredItems.length" class="py-10 text-center text-sm text-slate-500">Нет водителей</p>

      <div class="grid gap-2 sm:grid-cols-2">
        <DriverListItem v-for="driver in filteredItems" :key="driver.id" :driver="driver" :to="`/adminDrivers/${driver.id}`" />
      </div>
    </main>

    <AdminNav />
  </div>
</template>

<script>
import DriverListItem from './components/DriverListItem.vue'
import AdminNav from './components/AdminNav.vue'
import AdminThemeToggle from './components/AdminThemeToggle.vue'

const FILTERS = [
  { value: '', label: 'Все' },
  { value: 'PENDING', label: 'Ожидают' },
  { value: 'APPROVED', label: 'Одобрены' },
  { value: 'BLOCKED', label: 'Заблокированы' }
]

export default {
  name: 'AdminDrivers',
  components: { DriverListItem, AdminNav, AdminThemeToggle },
  data() {
    return { filters: FILTERS, search: '' }
  },
  computed: {
    items() {
      return this.$store.state.adminDrivers.items
    },
    // Client-side only - there is no search param on GET /admin/drivers,
    // and the already-fetched page of drivers is small enough that
    // filtering it locally is simpler and more honest than pretending the
    // backend supports a search query it doesn't.
    filteredItems() {
      const q = this.search.toLowerCase()
      if (!q) return this.items
      return this.items.filter((d) => (d.user.fullName || '').toLowerCase().includes(q) || (d.user.phone || '').includes(q))
    },
    total() {
      return this.$store.state.adminDrivers.total
    },
    loading() {
      return this.$store.state.adminDrivers.loading
    },
    statusFilter() {
      return this.$store.state.adminDrivers.statusFilter
    },
    onlineCount() {
      return this.$store.getters['adminDrivers/onlineCount']
    }
  },
  mounted() {
    this.$store.dispatch('adminDrivers/fetchList')
  },
  methods: {
    setFilter(value) {
      this.$store.dispatch('adminDrivers/setStatusFilter', value)
    }
  }
}
</script>
