<template>
  <span class="inline-flex flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium" :class="meta.class">{{ meta.label }}</span>
</template>

<script>
const META = {
  NEW: { label: 'Новый', class: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  ACCEPTED: { label: 'Принят', class: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500 dark:bg-opacity-10 dark:text-indigo-400' },
  WAITING: { label: 'Ожидание', class: 'bg-amber-50 text-amber-700 dark:bg-amber-500 dark:bg-opacity-10 dark:text-amber-400' },
  STARTED: { label: 'В пути', class: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500 dark:bg-opacity-10 dark:text-emerald-400' },
  COMPLETED: { label: 'Завершён', class: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500 dark:bg-opacity-20 dark:text-emerald-300' },
  CANCELLED: { label: 'Отменён', class: 'bg-red-50 text-red-700 dark:bg-red-500 dark:bg-opacity-10 dark:text-red-400' }
}

export default {
  name: 'OrderStatusBadge',
  props: {
    status: { type: String, required: true }
  },
  computed: {
    meta() {
      return META[this.status] || { label: this.status, class: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' }
    }
  }
}
</script>
