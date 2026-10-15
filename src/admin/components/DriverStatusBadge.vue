<template>
  <span class="inline-flex items-center gap-1.5">
    <span class="relative flex h-2 w-2">
      <span v-if="isOnline" class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      <span class="relative inline-flex h-2 w-2 rounded-full" :class="isOnline ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'" />
    </span>
    <span class="text-xs font-medium" :class="isOnline ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'">
      {{ isOnline ? 'Online' : 'Offline' }}
    </span>
    <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="statusMeta.class">{{ statusMeta.label }}</span>
  </span>
</template>

<script>
const STATUS_META = {
  PENDING: { label: 'Ожидает', class: 'bg-amber-50 text-amber-700 dark:bg-amber-500 dark:bg-opacity-10 dark:text-amber-400' },
  APPROVED: { label: 'Одобрен', class: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500 dark:bg-opacity-10 dark:text-emerald-400' },
  BLOCKED: { label: 'Заблокирован', class: 'bg-red-50 text-red-700 dark:bg-red-500 dark:bg-opacity-10 dark:text-red-400' }
}

export default {
  name: 'DriverStatusBadge',
  props: {
    status: { type: String, required: true },
    isOnline: { type: Boolean, default: false }
  },
  computed: {
    statusMeta() {
      return STATUS_META[this.status] || { label: this.status, class: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' }
    }
  }
}
</script>
