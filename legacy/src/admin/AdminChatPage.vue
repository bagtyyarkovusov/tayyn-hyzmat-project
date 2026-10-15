<template>
  <div class="flex min-h-screen flex-col bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-slate-800 dark:bg-slate-950">
      <div class="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3 sm:px-6">
        <button type="button" class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-900" @click="$router.back()">
          <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5"><path d="M15 5 8 12l7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <p class="truncate text-lg font-semibold">{{ driver ? driver.user.fullName : 'Чат' }}</p>
      </div>
    </header>

    <main class="mx-auto w-full max-w-3xl flex-1 px-4 py-3 pb-safe-mobile-nav-sm sm:px-6" style="height: calc(100vh - 140px);">
      <AdminChatThread :driver-id="driverId" />
    </main>

    <AdminNav />
  </div>
</template>

<script>
import AdminChatThread from './components/AdminChatThread.vue'
import AdminNav from './components/AdminNav.vue'

export default {
  name: 'AdminChatPage',
  components: { AdminChatThread, AdminNav },
  props: {
    driverId: { type: String, required: true }
  },
  computed: {
    driver() {
      return this.$store.state.adminDrivers.current
    }
  }
}
</script>
