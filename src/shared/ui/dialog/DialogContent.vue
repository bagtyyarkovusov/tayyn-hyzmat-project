<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { X } from "lucide-vue-next";
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui";
import { cn } from "@/shared/utils";

const props = defineProps<
  DialogContentProps & { class?: HTMLAttributes["class"] }
>();
const emits = defineEmits<DialogContentEmits>();

const delegatedProps = reactiveOmit(props, "class");

const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
  <DialogPortal>
    <DialogOverlay class="app-dialog-overlay fixed inset-0 z-50" />
    <DialogContent
      v-bind="forwarded"
      :class="
        cn(
          'app-dialog-content fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-1.5rem)] max-w-lg max-h-[85dvh] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border bg-background p-5',
          props.class,
        )
      "
    >
      <slot />

      <DialogClose
        class="dialog-close absolute right-1 top-1 flex size-11 items-center justify-center rounded-lg border-0 bg-transparent text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none"
      >
        <X class="w-4 h-4" />
        <span class="sr-only">Close</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>

<style>
/* Mobile keyboards resize the visual viewport without changing CSS vh. */
.app-dialog-content {
  top: calc(
    var(--app-viewport-top, 0px) + var(--app-viewport-height, 100dvh) / 2
  );
  max-height: calc(var(--app-viewport-height, 100dvh) - 1.5rem);
}

.app-dialog-overlay[data-state="open"] {
  animation: dialog-overlay-in 160ms ease-out;
}
.app-dialog-overlay[data-state="closed"] {
  animation: dialog-overlay-in 120ms ease-in reverse;
}
.app-dialog-content[data-state="open"] {
  animation: dialog-content-in 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.app-dialog-content[data-state="closed"] {
  animation: dialog-content-in 120ms ease-in reverse;
}
.app-dialog-content > div:first-child:not(.sr-only) {
  padding-right: 1.25rem;
}
@keyframes dialog-overlay-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes dialog-content-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .app-dialog-content[data-state] {
    animation-name: dialog-overlay-in;
    animation-duration: 100ms;
  }
}
</style>
