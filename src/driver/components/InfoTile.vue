<template>
  <div class="rounded-2xl border border-slate-200 bg-white p-3 dark:border-ink-600 dark:bg-ink-800">
    <p class="text-xs text-slate-500">{{ label }}</p>
    <p class="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{{ value }}</p>
  </div>
</template>

<script>
// A real .vue SFC, not an inline `{ template: '...' }` object - the
// installed `vue` package resolves to the runtime-only build (no
// runtimeCompiler in vue.config.js), which silently renders a STRING
// `template` option as nothing at all (an empty comment node, no error in
// production) instead of compiling it. This tile - and AdminDriverDetail's
// identical inline copy, and AdminDashboard's StatCard - used to be defined
// that way and were invisible for it.
export default {
  name: 'InfoTile',
  props: {
    label: { type: String, default: '' },
    value: { type: String, default: '' }
  }
}
</script>
