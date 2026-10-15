<template>
  <div class="pointer-events-none fixed inset-x-4 bottom-20 z-50 mx-auto flex max-w-md flex-col gap-2 md:bottom-6 md:left-64 md:right-4 md:max-w-sm">
    <transition-group name="toast" tag="div" class="flex flex-col gap-2">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="pointer-events-auto flex items-start gap-3 rounded-2xl border bg-white p-3.5 shadow-2xl dark:bg-ink-800"
        :class="variantClass(toast.variant)"
        @click="dismiss(toast.id)"
      >
        <span class="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full" :class="iconWrapClass(toast.variant)">
          <svg v-if="toast.variant === 'success'" viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5">
            <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else-if="toast.variant === 'error'" viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5">
            <path d="M12 8v5M12 15.5h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5">
            <path
              d="M4.5 6.5A2 2 0 0 1 6.5 4.5h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3.5V16.5H6.5a2 2 0 0 1-2-2v-8Z"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <div class="min-w-0 flex-1">
          <p v-if="toast.title" class="text-sm font-semibold text-slate-900 dark:text-white">{{ toast.title }}</p>
          <p class="text-sm text-slate-500 dark:text-slate-400">{{ toast.body }}</p>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<script>
const VARIANT_BORDER = {
  default: 'border-slate-200 dark:border-ink-600',
  success: 'border-brand-500 border-opacity-30',
  error: 'border-red-500 border-opacity-30'
}

const VARIANT_ICON = {
  default: 'bg-slate-100 text-slate-600 dark:bg-ink-700 dark:text-slate-300',
  success: 'bg-brand-500 bg-opacity-20 text-brand-700 dark:text-brand-400',
  error: 'bg-red-500 bg-opacity-20 text-red-700 dark:text-red-400'
}

export default {
  name: 'ToastHost',
  computed: {
    toasts() {
      return this.$store.state.ui.toasts
    }
  },
  methods: {
    variantClass(variant) {
      return VARIANT_BORDER[variant] || VARIANT_BORDER.default
    },
    iconWrapClass(variant) {
      return VARIANT_ICON[variant] || VARIANT_ICON.default
    },
    dismiss(id) {
      this.$store.dispatch('ui/dismissToast', id)
    }
  }
}
</script>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.toast-enter,
.toast-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.97);
}
.toast-leave-active {
  position: absolute;
}
</style>
