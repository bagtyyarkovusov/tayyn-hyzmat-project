<script setup lang="ts">
import { onUnmounted, reactive, ref } from "vue";
import { adminApi, errorMessage } from "@/shared/api";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import PhoneInput from "@/shared/ui/phone-input/PhoneInput.vue";
import { passwordError, passwordHint } from "@/shared/password";
import { Label } from "@/shared/ui/label";
import type { Driver } from "../domain";
const emit = defineEmits<{ created: [driver: Driver] }>();
const form = reactive({
  fullName: "",
  phone: "+993",
  password: "",
});
const pending = ref(false),
  error = ref("");
let alive = true;
onUnmounted(() => {
  alive = false;
});
async function submit() {
  if (pending.value) return;
  if (passwordError(form.password)) {
    error.value = passwordError(form.password);
    return;
  }
  pending.value = true;
  error.value = "";
  try {
    const { data } = await adminApi.post<Driver>("/admin/drivers", form);
    if (alive) emit("created", data);
  } catch (cause) {
    if (alive) error.value = errorMessage(cause);
  } finally {
    if (alive) pending.value = false;
  }
}
</script>
<template>
  <form class="space-y-5" @submit.prevent="submit">
    <fieldset :disabled="pending" class="grid min-w-0 gap-4">
      <div class="field">
        <Label for="driver-name">Имя</Label>
        <Input
          id="driver-name"
          v-model="form.fullName"
          required
          minlength="2"
          maxlength="120"
          autocomplete="name"
        />
      </div>
      <div class="field">
        <Label for="driver-phone">Телефон</Label>
        <PhoneInput id="driver-phone" v-model="form.phone" required />
      </div>
      <div class="field">
        <Label for="driver-password">Пароль</Label>
        <Input
          id="driver-password"
          v-model="form.password"
          type="password"
          required
          minlength="6"
          maxlength="72"
          autocomplete="new-password"
        />
        <p class="muted text-xs">
          {{ passwordHint }} Передайте пароль водителю.
        </p>
      </div>
    </fieldset>
    <p class="muted text-sm">
      Аккаунт доступен сразу. Передайте водителю номер и пароль для входа.
      Начальный баланс: 0 TMT. Пополните его в карточке водителя для выхода на
      линию. Район определится по GPS.
    </p>
    <p v-if="error" role="alert" class="text-sm text-destructive">
      {{ error }}
    </p>
    <Button type="submit" class="w-full" :disabled="pending">{{
      pending ? "Добавляем…" : "Добавить водителя"
    }}</Button>
  </form>
</template>
