<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { adminApi, errorMessage } from "@/shared/api";
import { adminSession } from "@/features/auth/session";
import { Button } from "@/shared/ui/button";
import PrivateOfferDriverPicker from "./PrivateOfferDriverPicker.vue";
const props = defineProps<{ orderId: string; initialDriverId?: string }>();
const emit = defineEmits<{ offered: [] }>();
const driverId = ref(props.initialDriverId ?? "");
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
      :disabled="pending"
    />
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
