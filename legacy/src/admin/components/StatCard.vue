<template>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900" :class="wide ? 'col-span-2' : ''">
    <div class="flex h-8 w-8 items-center justify-center rounded-xl" :class="accentClass">
      <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" v-html="icon" />
    </div>
    <p class="mt-2 text-2xl font-bold tabular-nums text-slate-900 dark:text-white">{{ value }}</p>
    <p class="mt-0.5 text-xs text-slate-500">{{ label }}</p>
  </div>
</template>

<script>
// A real .vue SFC - see driver/components/InfoTile.vue for why this used to
// be an inline `{ template: '...' }` object that silently rendered nothing.
const ACCENT_CLASS = {
  indigo: 'bg-indigo-500 bg-opacity-10 text-indigo-600 dark:text-indigo-400',
  brand: 'bg-emerald-500 bg-opacity-10 text-emerald-600 dark:text-emerald-400',
  amber: 'bg-amber-500 bg-opacity-10 text-amber-600 dark:text-amber-400',
  red: 'bg-red-500 bg-opacity-10 text-red-600 dark:text-red-400'
}

export default {
  name: 'StatCard',
  props: {
    label: { type: String, required: true },
    value: { type: [String, Number], required: true },
    accent: { type: String, default: 'indigo' },
    icon: { type: String, required: true },
    wide: { type: Boolean, default: false }
  },
  computed: {
    accentClass() {
      return ACCENT_CLASS[this.accent] || 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
    }
  }
}
</script>
