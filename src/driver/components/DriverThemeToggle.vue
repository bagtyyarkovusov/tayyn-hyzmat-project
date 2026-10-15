<template>
  <div class="inline-flex items-center gap-0.5 rounded-xl border border-slate-200 bg-slate-100 p-0.5 dark:border-ink-600 dark:bg-ink-900">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded-lg transition-colors duration-150"
      :class="preference === opt.value ? 'bg-white text-brand-600 shadow dark:bg-ink-700 dark:text-brand-400' : 'text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'"
      :title="opt.title"
      :aria-label="opt.title"
      @click="$store.dispatch('ui/setPreference', opt.value)"
    >
      <svg v-if="opt.value === 'light'" viewBox="0 0 24 24" fill="none" class="h-4 w-4">
        <circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.8" />
        <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
      <svg v-else-if="opt.value === 'dark'" viewBox="0 0 24 24" fill="none" class="h-4 w-4">
        <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.6 6.6 0 0 0 10.5 10.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none" class="h-4 w-4">
        <rect x="3" y="4.5" width="18" height="12" rx="1.8" stroke="currentColor" stroke-width="1.8" />
        <path d="M8.5 20h7M12 16.5V20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</template>

<script>
// Same component as admin/components/AdminThemeToggle.vue (same
// ui/setPreference action, same 3-way light/dark/system control) - kept as
// its own copy rather than shared/imported since it lives in the
// driver-only APK bundle (src/main-driver.js / driver-router.js) which
// never pulls in anything under src/admin/**, and uses the driver panel's
// own brand/ink color tokens instead of admin's indigo/slate ones.
export default {
  name: 'DriverThemeToggle',
  data() {
    return {
      options: [
        { value: 'light', title: 'Светлая тема' },
        { value: 'dark', title: 'Тёмная тема' },
        { value: 'system', title: 'Как в системе' }
      ]
    }
  },
  computed: {
    preference() {
      return this.$store.state.ui.themePreference
    }
  }
}
</script>
