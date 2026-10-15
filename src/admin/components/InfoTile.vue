<template>
  <div class="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
    <p class="text-xs text-slate-500">{{ label }}</p>
    <p class="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{{ value }}</p>
  </div>
</template>

<script>
// A real .vue SFC, not an inline `{ template: '...' }` object - see
// driver/components/InfoTile.vue for why that pattern silently renders
// nothing under this project's runtime-only Vue build.
export default {
  name: 'InfoTile',
  props: {
    label: { type: String, default: '' },
    value: { type: String, default: '' }
  }
}
</script>
