<script setup lang="ts">
import type { DialogRootEmits, DialogRootProps } from "reka-ui";
import { DialogRoot, useForwardProps } from "reka-ui";
import { reactiveOmit, useVModel } from "@vueuse/core";
import { useOverlay } from "@/shared/overlays";

const props = withDefaults(
  defineProps<
    DialogRootProps & {
      /** Native Back leaves a newly opened dialog alone for this long. */
      backGuardMs?: number;
    }
  >(),
  { open: undefined, backGuardMs: 0 },
);
const emits = defineEmits<DialogRootEmits>();

const open =
  props.open === undefined
    ? useVModel(props, "open", emits, {
        passive: true,
        defaultValue: props.defaultOpen ?? false,
      })
    : useVModel(props, "open", emits, { passive: false });
useOverlay(open, () => props.backGuardMs);
const forwarded = useForwardProps(
  reactiveOmit(props, "open", "defaultOpen", "backGuardMs"),
);
</script>

<template>
  <DialogRoot v-bind="forwarded" v-model:open="open">
    <slot />
  </DialogRoot>
</template>
