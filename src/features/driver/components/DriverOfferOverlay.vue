<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import IncomingOrder from "./IncomingOrder.vue";
import { OFFER_BACK_GUARD_MS, useDriver } from "../useDriver";
const { state, closeIncoming } = useDriver();
</script>
<template>
  <Dialog
    :open="!!state.incoming && !state.active"
    :back-guard-ms="OFFER_BACK_GUARD_MS"
    @update:open="!$event && closeIncoming()"
  >
    <DialogContent
      ><DialogHeader class="sr-only"
        ><DialogTitle>Предложение заказа</DialogTitle></DialogHeader
      ><IncomingOrder embedded />
      <p v-if="state.error" role="alert" class="text-sm text-destructive">
        {{ state.error }}
      </p></DialogContent
    >
  </Dialog>
</template>
