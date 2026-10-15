<template>
  <component
    :is="clickable ? 'button' : 'span'"
    :type="clickable ? 'button' : undefined"
    class="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors duration-200"
    :class="colorClass"
    @click="clickable && $emit('click')"
  >
    <span class="relative flex h-1.5 w-1.5 flex-shrink-0">
      <span v-if="state === 'on'" class="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
      <span class="relative inline-flex h-1.5 w-1.5 rounded-full" :class="dotClass" />
    </span>
    {{ label }}
  </component>
</template>

<script>
const DOT_CLASS = {
  on: 'bg-brand-500',
  warning: 'bg-amber-500',
  off: 'bg-red-500'
}

const COLOR_CLASS = {
  on: 'border-brand-500 border-opacity-30 bg-brand-500 bg-opacity-10 text-brand-700 dark:text-brand-400',
  warning: 'border-amber-500 border-opacity-30 bg-amber-500 bg-opacity-10 text-amber-700 dark:text-amber-400',
  off: 'border-red-500 border-opacity-30 bg-red-500 bg-opacity-10 text-red-700 dark:text-red-400'
}

export default {
  name: 'StatusPill',
  props: {
    state: { type: String, required: true }, // 'on' | 'warning' | 'off'
    label: { type: String, required: true },
    clickable: { type: Boolean, default: false }
  },
  computed: {
    dotClass() {
      return DOT_CLASS[this.state] || DOT_CLASS.off
    },
    colorClass() {
      return COLOR_CLASS[this.state] || COLOR_CLASS.off
    }
  }
}
</script>
