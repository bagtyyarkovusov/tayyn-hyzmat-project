<script setup lang="ts">
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });
</script>

<template>
  <span class="brand-lockup" :class="{ 'brand-lockup-compact': compact }">
    <svg class="brand-mark" viewBox="0 0 80 80" fill="none" aria-hidden="true">
      <rect width="80" height="80" rx="16" fill="currentColor" />
      <path d="M18 21H62V31H45V62H35V31H18V21Z" class="brand-letter" />
    </svg>
    <span class="brand-name">Tayyn Hyzmat</span>
  </span>
</template>

<style scoped>
.brand-lockup {
  display: inline-flex;
  align-items: center;
  gap: 0.65rem;
  min-width: 0;
  color: inherit;
}
.brand-mark {
  width: 2.25rem;
  height: 2.25rem;
  flex-shrink: 0;
}
.brand-letter {
  fill: var(--card);
}
.brand-name {
  font-size: 1rem;
  font-weight: 750;
  letter-spacing: -0.035em;
  line-height: 1.2;
  white-space: nowrap;
}
.brand-lockup-compact .brand-mark {
  width: 1.75rem;
  height: 1.75rem;
}
.brand-lockup-compact .brand-name {
  font-size: 0.875rem;
}
:global(.auth-story) .brand-letter {
  fill: #111;
}
</style>
