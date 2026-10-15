<template>
  <div>
    <!-- Desktop: fixed left sidebar -->
    <aside class="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col overflow-y-auto border-r border-slate-200 bg-white px-3 py-5 dark:border-ink-600 dark:bg-ink-900 md:flex">
      <div class="mb-6 flex items-center gap-2.5 px-2">
        <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">T</div>
        <span class="truncate text-sm font-semibold text-slate-900 dark:text-white">Tayyn hyzmat</span>
      </div>

      <nav class="flex-1 space-y-1">
        <router-link
          to="/driverDashboard"
          class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-150"
          :class="isActive('/driverDashboard') ? 'bg-brand-500 bg-opacity-10 text-brand-600 dark:text-brand-400' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-200'"
        >
          <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5 flex-shrink-0">
            <path d="M4 11.5 12 4l8 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M6 10v9.5a1 1 0 0 0 1 1h3.5v-6h3v6H17a1 1 0 0 0 1-1V10" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
          </svg>
          Главная
        </router-link>

        <router-link
          to="/driverMap"
          class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-150"
          :class="isActive('/driverMap') ? 'bg-brand-500 bg-opacity-10 text-brand-600 dark:text-brand-400' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-200'"
        >
          <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5 flex-shrink-0">
            <path d="M9 4.5 4.5 6v13.5L9 18l6 1.5 4.5-1.5V4.5L15 6 9 4.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            <path d="M9 4.5V18M15 6v13.5" stroke="currentColor" stroke-width="1.8" />
          </svg>
          Карта
        </router-link>

        <router-link
          to="/driverProfile"
          class="relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-150"
          :class="isActive('/driverProfile') || isActive('/driverChat') ? 'bg-brand-500 bg-opacity-10 text-brand-600 dark:text-brand-400' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-200'"
        >
          <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5 flex-shrink-0">
            <circle cx="12" cy="8" r="3.3" stroke="currentColor" stroke-width="1.8" />
            <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
          Профиль
          <span v-if="unreadCount" class="absolute right-3 top-2.5 flex h-2 w-2 rounded-full bg-red-500" />
        </router-link>
      </nav>

      <DriverThemeToggle class="mb-2 self-start" />

      <button
        type="button"
        class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-red-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-red-400"
        @click="logout"
      >
        <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5 flex-shrink-0">
          <path d="M15 4.5H8.5A1.5 1.5 0 0 0 7 6v12a1.5 1.5 0 0 0 1.5 1.5H15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
          <path d="M20 12H10.5M20 12l-3-3M20 12l-3 3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Выйти
      </button>
    </aside>

    <!-- Mobile: fixed bottom tab bar -->
    <nav class="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white bg-opacity-95 backdrop-blur dark:border-ink-600 dark:bg-ink-900 md:hidden">
      <div class="nav-safe-bottom mx-auto flex max-w-md items-stretch justify-around px-2 pt-1">
        <router-link
          to="/driverDashboard"
          class="flex flex-col items-center gap-0.5 rounded-xl px-4 py-1 text-xs font-medium transition-colors duration-200"
          :class="isActive('/driverDashboard') ? 'text-brand-600 dark:text-brand-400' : 'text-slate-500'"
        >
          <span class="flex h-7 w-7 items-center justify-center rounded-lg transition-colors duration-200" :class="isActive('/driverDashboard') ? 'bg-brand-500 bg-opacity-10' : ''">
            <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5">
              <path d="M4 11.5 12 4l8 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M6 10v9.5a1 1 0 0 0 1 1h3.5v-6h3v6H17a1 1 0 0 0 1-1V10" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            </svg>
          </span>
          Главная
        </router-link>

        <router-link
          to="/driverMap"
          class="flex flex-col items-center gap-0.5 rounded-xl px-4 py-1 text-xs font-medium transition-colors duration-200"
          :class="isActive('/driverMap') ? 'text-brand-600 dark:text-brand-400' : 'text-slate-500'"
        >
          <span class="flex h-7 w-7 items-center justify-center rounded-lg transition-colors duration-200" :class="isActive('/driverMap') ? 'bg-brand-500 bg-opacity-10' : ''">
            <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5">
              <path d="M9 4.5 4.5 6v13.5L9 18l6 1.5 4.5-1.5V4.5L15 6 9 4.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
              <path d="M9 4.5V18M15 6v13.5" stroke="currentColor" stroke-width="1.8" />
            </svg>
          </span>
          Карта
        </router-link>

        <router-link
          to="/driverProfile"
          class="flex flex-col items-center gap-0.5 rounded-xl px-4 py-1 text-xs font-medium transition-colors duration-200"
          :class="isActive('/driverProfile') || isActive('/driverChat') ? 'text-brand-600 dark:text-brand-400' : 'text-slate-500'"
        >
          <span
            class="relative flex h-7 w-7 items-center justify-center rounded-lg transition-colors duration-200"
            :class="isActive('/driverProfile') || isActive('/driverChat') ? 'bg-brand-500 bg-opacity-10' : ''"
          >
            <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5">
              <circle cx="12" cy="8" r="3.3" stroke="currentColor" stroke-width="1.8" />
              <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
            <span v-if="unreadCount" class="absolute right-0.5 top-0.5 flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
          Профиль
        </router-link>
      </div>
    </nav>
  </div>
</template>

<script>
import DriverThemeToggle from './DriverThemeToggle.vue'

export default {
  name: 'BottomNav',
  components: { DriverThemeToggle },
  computed: {
    unreadCount() {
      return this.$store.state.driverChat.unreadCount
    }
  },
  methods: {
    isActive(path) {
      return this.$route.path === path
    },
    logout() {
      this.$store.dispatch('driverAuth/logout')
      this.$router.replace('/driverLogin')
    }
  }
}
</script>
