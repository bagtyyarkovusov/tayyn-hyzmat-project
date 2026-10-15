<script setup lang="ts">
import { Button } from "@/shared/ui/button";
defineProps<{ loading?: boolean; error?: string; empty?: boolean }>();
defineEmits<{ retry: [] }>();
</script>
<template>
  <div
    v-if="error"
    role="alert"
    class="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
  >
    <p>{{ error }}</p>
    <Button class="mt-3" variant="outline" @click="$emit('retry')"
      >Повторить</Button
    >
  </div>
  <p
    v-else-if="loading"
    role="status"
    class="py-8 text-sm text-muted-foreground"
  >
    Загрузка данных…
  </p>
  <div
    v-else-if="empty"
    class="rounded-xl border border-dashed p-10 text-center"
  >
    <p class="font-medium">Здесь пока пусто</p>
    <p class="mt-1 text-sm text-muted-foreground">
      Новые данные появятся автоматически.
    </p>
  </div>
</template>
