<template>
  <router-link
    :to="to"
    class="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 transition-colors duration-150 hover:border-indigo-400 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-500"
  >
    <div class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
      {{ initials }}
    </div>

    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{{ driver.user.fullName }}</p>
      <p class="truncate text-xs text-slate-500">{{ driver.user.phone }}</p>
      <div class="mt-1 flex flex-wrap items-center gap-1.5">
        <DriverStatusBadge :status="driver.status" :is-online="driver.isOnline" />
        <span
          v-if="driver.pendingDeviceId"
          class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500 dark:bg-opacity-10 dark:text-amber-400"
        >
          Новое устройство
        </span>
      </div>
    </div>

    <div v-if="showBalance" class="flex-shrink-0 text-right">
      <p class="text-sm font-bold tabular-nums text-slate-900 dark:text-slate-100">{{ formattedBalance }}</p>
      <p class="text-xs text-slate-500">TMT</p>
    </div>

    <slot />
  </router-link>
</template>

<script>
import DriverStatusBadge from './DriverStatusBadge.vue'

export default {
  name: 'DriverListItem',
  components: { DriverStatusBadge },
  props: {
    driver: { type: Object, required: true },
    to: { type: [String, Object], required: true },
    showBalance: { type: Boolean, default: true }
  },
  computed: {
    initials() {
      return (this.driver.user.fullName || '?')
        .split(' ')
        .map((part) => part[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    },
    formattedBalance() {
      const amount = this.driver.user.balance ? Number(this.driver.user.balance.amount) : 0
      return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount)
    }
  }
}
</script>
