<script setup lang="ts">
import { Button } from "@/shared/ui/button";
withDefaults(
  defineProps<{
    loading?: boolean;
    error?: string;
    empty?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
  }>(),
  {
    emptyTitle: "Нет записей",
    emptyDescription: "Новые записи появятся здесь.",
  },
);
defineEmits<{ retry: [] }>();
</script>
<template>
  <div
    v-if="error"
    role="alert"
    class="flex flex-wrap items-center justify-between gap-3 border-y border-destructive/30 py-3 text-sm"
  >
    <p>{{ error }}</p>
    <Button variant="outline" @click="$emit('retry')">Повторить</Button>
  </div>
  <p
    v-else-if="loading"
    role="status"
    class="py-4 text-sm text-muted-foreground"
  >
    Загрузка данных…
  </p>
  <div v-else-if="empty" class="border-y py-4">
    <p class="font-medium">{{ emptyTitle }}</p>
    <p class="mt-1 text-sm text-muted-foreground">
      {{ emptyDescription }}
    </p>
  </div>
</template>
