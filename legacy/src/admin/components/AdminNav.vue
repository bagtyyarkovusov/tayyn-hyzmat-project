<template>
  <div>
    <!-- Desktop: fixed left sidebar -->
    <aside class="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col overflow-y-auto border-r border-slate-200 bg-white px-3 py-5 dark:border-slate-800 dark:bg-slate-950 md:flex">
      <div class="mb-6 flex items-center gap-2.5 px-2">
        <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">T</div>
        <span class="truncate text-sm font-semibold text-slate-900 dark:text-white">Tayyn hyzmat</span>
      </div>

      <nav class="flex-1 space-y-1">
        <router-link
          v-for="item in items"
          :key="item.to"
          :to="item.to"
          class="relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-150"
          :class="isActive(item.to) ? 'bg-indigo-500 bg-opacity-10 text-indigo-600 dark:text-indigo-400' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-200'"
        >
          <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5 flex-shrink-0" v-html="item.icon" />
          {{ item.label }}
          <span v-if="item.to === '/adminChat' && hasUnreadMessages" class="ml-auto h-2 w-2 flex-shrink-0 rounded-full bg-red-500" />
        </router-link>
      </nav>

      <AdminThemeToggle class="mb-2 self-start" />

      <button
        type="button"
        class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-red-600 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-red-400"
        @click="logout"
      >
        <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5 flex-shrink-0">
          <path d="M15 4.5H8.5A1.5 1.5 0 0 0 7 6v12a1.5 1.5 0 0 0 1.5 1.5H15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
          <path d="M20 12H10.5M20 12l-3-3M20 12l-3 3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Выйти
      </button>
    </aside>

    <!-- Mobile: bottom tab bar, horizontally scrollable so 6 sections stay
         reachable and finger-sized on a 320px screen instead of squeezing
         every icon down to be unusably small. -->
    <nav class="fixed inset-x-0 bottom-0 z-30 overflow-x-auto border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 md:hidden">
      <div class="nav-safe-bottom-lg flex items-stretch justify-around px-1 pt-1.5" style="min-width: max-content; width: 100%;">
        <router-link
          v-for="item in items"
          :key="item.to"
          :to="item.to"
          class="relative flex flex-shrink-0 flex-col items-center gap-0.5 rounded-xl px-3.5 py-1.5 text-xs font-medium transition-colors duration-200"
          :class="isActive(item.to) ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'"
        >
          <span class="relative">
            <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5" v-html="item.icon" />
            <span v-if="item.to === '/adminChat' && hasUnreadMessages" class="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500" />
          </span>
          {{ item.label }}
        </router-link>
      </div>
    </nav>
  </div>
</template>

<script>
import AdminThemeToggle from './AdminThemeToggle.vue'

const ICONS = {
  dashboard:
    '<path d="M4 11.5 12 4l8 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 10v9.5a1 1 0 0 0 1 1h3.5v-6h3v6H17a1 1 0 0 0 1-1V10" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  orders:
    '<rect x="4.5" y="5" width="15" height="15" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 3.5v3M15.5 3.5v3M4.5 10h15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  drivers:
    '<path d="M5 20v-1.5A3.5 3.5 0 0 1 8.5 15h7a3.5 3.5 0 0 1 3.5 3.5V20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="8" r="3.5" stroke="currentColor" stroke-width="1.8"/>',
  map:
    '<path d="M9 4.5 4.5 6v13.5L9 18l6 1.5 4.5-1.5V4.5L15 6 9 4.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 4.5V18M15 6v13.5" stroke="currentColor" stroke-width="1.8"/>',
  districts:
    '<rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="4" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="4" y="13" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="13" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/>',
  chat:
    '<path d="M4.5 6.5A2 2 0 0 1 6.5 4.5h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3.5V16.5H6.5a2 2 0 0 1-2-2v-8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
}

export default {
  name: 'AdminNav',
  components: { AdminThemeToggle },
  data() {
    return {
      items: [
        { to: '/adminDashboard', label: 'Главная', icon: ICONS.dashboard },
        { to: '/adminOrders', label: 'Заказы', icon: ICONS.orders },
        { to: '/adminDrivers', label: 'Водители', icon: ICONS.drivers },
        { to: '/adminMonitoring', label: 'Карта', icon: ICONS.map },
        { to: '/adminDistricts', label: 'Районы', icon: ICONS.districts },
        { to: '/adminChat', label: 'Чат', icon: ICONS.chat }
      ]
    }
  },
  computed: {
    hasUnreadMessages() {
      return this.$store.getters['adminDrivers/hasUnreadMessages']
    }
  },
  // AdminNav is part of every admin page's own template (not a persistent
  // layout wrapper), so it remounts on every navigation - a cheap refetch
  // here keeps the badge correct after returning from another tab/device,
  // and the driver:message socket handler (adminAuth.js) keeps it live
  // in between without needing to poll.
  mounted() {
    this.$store.dispatch('adminDrivers/fetchUnread').catch(() => {})
  },
  methods: {
    isActive(path) {
      return this.$route.path === path || this.$route.path.startsWith(path + '/')
    },
    logout() {
      this.$store.dispatch('adminAuth/logout')
      this.$router.replace('/adminLogin')
    }
  }
}
</script>
