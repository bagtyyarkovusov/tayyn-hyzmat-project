<template>
  <div
    class="relative flex flex-col justify-between rounded-2xl border bg-white p-3 transition-all duration-300 dark:bg-slate-900"
    :class="pulse ? 'border-indigo-400 shadow-lg' : 'border-slate-200 dark:border-slate-800'"
    style="aspect-ratio: 1 / 1;"
  >
    <p class="truncate text-xs font-semibold text-slate-500">{{ name }}</p>

    <div class="flex flex-1 flex-col items-center justify-center">
      <p class="text-2xl font-bold tabular-nums text-slate-900 dark:text-white sm:text-3xl">
        <span>{{ activeOrders }}</span>
        <span class="mx-0.5 text-slate-300 dark:text-slate-600">:</span>
        <span :class="freeDrivers > 0 ? 'text-emerald-600 dark:text-emerald-400' : ''">{{ freeDrivers }}</span>
      </p>
    </div>

    <div class="space-y-0.5 text-xs leading-tight text-slate-500">
      <p>Заказы: <span class="font-medium text-slate-700 dark:text-slate-300">{{ activeOrders }}</span></p>
      <p>Машины: <span class="font-medium text-slate-700 dark:text-slate-300">{{ freeDrivers }}</span></p>
    </div>
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
