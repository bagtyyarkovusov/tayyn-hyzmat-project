<template>
  <div
    class="relative flex flex-col gap-1.5 overflow-hidden rounded-xl border bg-white p-2 text-left transition-all duration-300 active:scale-95 dark:bg-ink-800"
    :class="pulse ? 'border-brand-500 shadow-lg shadow-brand-500/10' : 'border-slate-200 dark:border-ink-600'"
    role="button"
    tabindex="0"
    @click="$emit('click')"
    @keyup.enter="$emit('click')"
  >
    <p class="text-xs font-bold leading-snug text-slate-900 dark:text-white">{{ name }}</p>

    <p class="rounded-lg bg-slate-100 py-1 text-center text-sm font-bold tabular-nums dark:bg-ink-900">
      <span class="text-slate-900 dark:text-white">{{ activeOrders }}</span>
      <span class="mx-1 text-slate-400 dark:text-slate-600">:</span>
      <span :class="freeDrivers > 0 ? 'text-brand-600 dark:text-brand-400' : 'text-slate-900 dark:text-white'">{{ freeDrivers }}</span>
    </p>
  </div>
</template>

<script>
export default {
  name: 'DistrictCard',
  props: {
    name: { type: String, required: true },
    activeOrders: { type: Number, default: 0 },
    freeDrivers: { type: Number, default: 0 }
  },
  data() {
    return { pulse: false }
  },
  watch: {
    activeOrders() {
      this.triggerPulse()
    },
    freeDrivers() {
      this.triggerPulse()
    }
  },
  methods: {
    triggerPulse() {
      this.pulse = true
      window.clearTimeout(this._pulseTimer)
      this._pulseTimer = window.setTimeout(() => {
        this.pulse = false
      }, 700)
    }
  }
}
</script>
