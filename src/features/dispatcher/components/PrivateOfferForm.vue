<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { adminApi, errorMessage } from "@/shared/api";
import { adminSession } from "@/features/auth/session";
import { Button } from "@/shared/ui/button";
import PrivateOfferDriverPicker from "./PrivateOfferDriverPicker.vue";
const props = defineProps<{
  orderId: string;
  priceEstimated?: number | string | null;
  initialDriverId?: string;
}>();
const emit = defineEmits<{ offered: [] }>();
const driverId = ref(props.initialDriverId ?? "");
const broadcastAfterPrivateExpiry = ref(true);
const pending = ref(false),
  error = ref("");
let disposed = false;
onUnmounted(() => {
  disposed = true;
});
async function submit() {
  if (pending.value || !driverId.value) return;
  const userId = adminSession.state.user?.id;
  pending.value = true;
  error.value = "";
  try {
    await adminApi.post(`/admin/orders/${props.orderId}/private-offer`, {
      driverId: driverId.value,
      broadcastAfterPrivateExpiry: broadcastAfterPrivateExpiry.value,
    });
    if (!disposed && userId === adminSession.state.user?.id) emit("offered");
  } catch (cause) {
    if (!disposed && userId === adminSession.state.user?.id)
      error.value = errorMessage(cause);
  } finally {
    if (!disposed) pending.value = false;
  }
}
</script>
<template>
  <form class="space-y-4" @submit.prevent="submit">
    <PrivateOfferDriverPicker
      id="offer-driver"
      v-model="driverId"
      :price-estimated="priceEstimated"
      :disabled="pending"
    />
    <label
      for="broadcast-after-private-expiry-existing"
      class="flex items-start gap-3 rounded-md border border-border/70 p-3 text-sm"
    >
      <input
        id="broadcast-after-private-expiry-existing"
        v-model="broadcastAfterPrivateExpiry"
        type="checkbox"
        class="mt-0.5 size-4 accent-primary"
        :disabled="pending"
      />
      <span>
        <span class="font-medium"
          >Предложить другим водителям после 20 секунд</span
        >
        <span class="mt-0.5 block text-xs text-muted-foreground">
          При включении заказ одновременно появится во всех доступных районах.
        </span>
      </span>
    </label>
    <p v-if="error" role="alert" class="text-sm text-destructive">
      {{ error }}
    </p>
    <Button
      class="w-full sm:w-auto"
      :disabled="pending || !driverId"
      type="submit"
      >{{ pending ? "Отправляем…" : "Предложить на 20 секунд" }}</Button
    >
  </form>
</template>
