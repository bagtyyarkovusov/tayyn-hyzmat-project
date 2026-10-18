<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import IncomingOrder from "./IncomingOrder.vue";
import { useDriver } from "../useDriver";
const { state, declinePrivateOffer, dismissIncoming } = useDriver();
function close() {
  if (state.incoming?.privateOfferExpiresAt) void declinePrivateOffer();
  else dismissIncoming();
}
</script>
<template>
  <Dialog
    :open="!!state.incoming && !state.active"
    @update:open="!$event && close()"
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
