<script setup lang="ts">
import { ref, watch } from "vue";
import { Check, CircleAlert, X } from "lucide-vue-next";
import {
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport,
} from "reka-ui";
import { consumeDriverNotice } from "../useDriver";
import { Button } from "@/shared/ui/button";

const props = defineProps<{
  blockers: string[];
  error: string;
  notice: string;
  noticeEventId?: string;
  attempt: number;
}>();
const open = ref(false);
const text = ref("");
const destructive = ref(false);
const notification = ref(0);
const seenMessages = new Set<string>();
let lastAttempt = -1;
watch(
  () =>
    [props.error, props.notice, props.attempt, props.noticeEventId] as const,
  ([error, notice, attempt, eventId]) => {
    const newAttempt = attempt !== lastAttempt;
    if (newAttempt) {
      seenMessages.clear();
      lastAttempt = attempt;
    }
    const message = error || notice;
    if (!message) {
      // Background refreshes clear their previous error before requesting.
      // Preserve reading time; an explicit next action may dismiss it early.
      if (newAttempt) open.value = false;
      return;
    }
    const key = `${error ? "error" : "notice"}:${message}`;
    // Background refreshes can clear and repeat the same failure. Only a new
    // message or an explicit driver retry should create another notification.
    if (seenMessages.has(key)) return;
    if (
      !error &&
      !consumeDriverNotice(eventId || `notice:${attempt}:${notice}`)
    )
      return;
    seenMessages.add(key);
    text.value = message;
    destructive.value = Boolean(error);
    notification.value++;
    open.value = true;
  },
  { immediate: true },
);
</script>

<template>
  <p
    id="driver-gps-blocker"
    v-if="blockers.length"
    class="col-span-full text-xs leading-relaxed text-muted-foreground"
    role="status"
    aria-label="Для выхода на линию"
  >
    {{ blockers.join(" ") }}
  </p>
  <ToastProvider label="Сообщение" :disable-swipe="true">
    <ToastRoot
      :key="notification"
      v-model:open="open"
      :duration="destructive ? 8000 : 4500"
      :type="destructive ? 'foreground' : 'background'"
      aria-label="Сообщение водителю"
      class="flex items-center gap-3 rounded-xl bg-card py-2 pl-4 pr-1 text-sm text-foreground shadow-lg motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=open]:slide-in-from-bottom-2 motion-safe:data-[state=open]:duration-150"
    >
      <CircleAlert
        v-if="destructive"
        class="size-4 shrink-0 text-destructive"
        aria-hidden="true"
      />
      <Check v-else class="size-4 shrink-0 text-primary" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <ToastTitle class="sr-only">{{
          destructive ? "Действие не выполнено" : "Готово"
        }}</ToastTitle>
        <ToastDescription class="break-words">{{ text }}</ToastDescription>
      </div>
      <ToastClose as-child>
        <Button
          variant="ghost"
          size="icon"
          class="size-11 shrink-0 rounded-full"
          aria-label="Скрыть сообщение"
        >
          <X class="size-4" aria-hidden="true" />
        </Button>
      </ToastClose>
    </ToastRoot>
    <ToastViewport
      label="Сообщения водителю ({hotkey})"
      class="fixed bottom-[calc(5.5rem+var(--native-safe-bottom,env(safe-area-inset-bottom,0px)))] left-1/2 z-[60] flex w-[calc(100%-1rem)] max-w-xl -translate-x-1/2 flex-col outline-none"
    />
  </ToastProvider>
</template>
