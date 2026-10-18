<script setup lang="ts">
import type { DropdownMenuRootEmits, DropdownMenuRootProps } from "reka-ui";
import { DropdownMenuRoot, useForwardProps } from "reka-ui";
import { reactiveOmit, useVModel } from "@vueuse/core";
import { useOverlay } from "@/shared/overlays";

const props = withDefaults(defineProps<DropdownMenuRootProps>(), {
  open: undefined,
});
const emits = defineEmits<DropdownMenuRootEmits>();

const open =
  props.open === undefined
    ? useVModel(props, "open", emits, {
        passive: true,
        defaultValue: props.defaultOpen ?? false,
      })
    : useVModel(props, "open", emits, { passive: false });
useOverlay(open);
const forwarded = useForwardProps(reactiveOmit(props, "open", "defaultOpen"));
</script>

<template>
  <DropdownMenuRoot v-bind="forwarded" v-model:open="open">
    <slot />
  </DropdownMenuRoot>
</template>
