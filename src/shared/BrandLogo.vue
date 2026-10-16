<script setup lang="ts">
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });
</script>

<template>
  <span class="brand-lockup" :class="{ 'brand-lockup-compact': compact }">
    <span class="brand-mark" aria-hidden="true">
      <img class="brand-light" src="/brand/mark-light.png" alt="" />
      <img class="brand-dark" src="/brand/mark-dark.png" alt="" />
    </span>
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
  width: 2.75rem;
  height: 2.75rem;
  flex-shrink: 0;
}
.brand-mark img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.brand-dark {
  display: none;
}
:global(.dark) .brand-light,
:global(.auth-story) .brand-light {
  display: none;
}
:global(.dark) .brand-dark,
:global(.auth-story) .brand-dark {
  display: block;
}
.brand-name {
  font-size: 1rem;
  font-weight: 750;
  letter-spacing: -0.035em;
  line-height: 1.2;
  white-space: nowrap;
}
.brand-lockup-compact .brand-mark {
  width: 2.25rem;
  height: 2.25rem;
}
.brand-lockup-compact .brand-name {
  font-size: 0.875rem;
}
</style>
