<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-slate-800 dark:bg-slate-950">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
        <h1 class="text-lg font-semibold">Районы</h1>
        <div class="flex items-center gap-2">
          <router-link
            to="/adminDistricts/boundaries"
            class="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white transition-colors duration-150 hover:bg-indigo-500"
          >
            Границы районов
          </router-link>
          <AdminThemeToggle class="md:hidden" />
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl px-4 py-6 pb-safe-mobile-nav sm:px-6">
      <!-- Same `districts` Vuex module as the driver panel - one realtime
           source of truth - but its own light/dark-aware DistrictGrid/Card,
           since the driver panel's version is colored directly with the
           fixed dark `ink-*` palette and would ignore the admin theme toggle. -->
      <DistrictGrid />
    </main>

    <AdminNav />
  </div>
</template>

<script>
import DistrictGrid from './components/DistrictGrid.vue'
import AdminNav from './components/AdminNav.vue'
import AdminThemeToggle from './components/AdminThemeToggle.vue'

export default {
  name: 'AdminDistricts',
  components: { DistrictGrid, AdminNav, AdminThemeToggle }
}
</script>
