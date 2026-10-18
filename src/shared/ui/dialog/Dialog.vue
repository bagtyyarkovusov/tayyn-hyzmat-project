<script setup lang="ts">
import type { DialogRootEmits, DialogRootProps } from "reka-ui";
import { DialogRoot, useForwardProps } from "reka-ui";
import { reactiveOmit, useVModel } from "@vueuse/core";
import { useOverlay } from "@/shared/overlays";

const props = defineProps<DialogRootProps>();
const emits = defineEmits<DialogRootEmits>();

const open = useVModel(props, "open", emits, {
  passive: true,
  defaultValue: props.defaultOpen ?? false,
});
useOverlay(open);
const forwarded = useForwardProps(reactiveOmit(props, "open", "defaultOpen"));
</script>

<template>
  <DialogRoot v-bind="forwarded" v-model:open="open">
    <slot />
  </DialogRoot>
</template>
