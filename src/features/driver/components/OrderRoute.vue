<script setup lang="ts">
import { MapPin, Flag } from "lucide-vue-next";
defineProps<{
  pickup?: string | null;
  destination?: string | null;
  note?: string | null;
}>();
</script>
<template>
  <div class="min-w-0 space-y-3 text-base leading-relaxed">
    <p class="flex items-start gap-3">
      <MapPin
        class="mt-1 size-5 shrink-0 text-primary"
        aria-hidden="true"
      /><span class="min-w-0 break-words [overflow-wrap:anywhere]">{{
        pickup || "Подача уточняется по телефону"
      }}</span>
    </p>
    <p v-if="destination" class="flex items-start gap-3">
      <Flag
        class="mt-1 size-5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      /><span class="min-w-0 break-words [overflow-wrap:anywhere]">{{
        destination
      }}</span>
    </p>
    <p
      v-if="note"
      class="whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"
    >
      {{ note }}
    </p>
  </div>
</template>
