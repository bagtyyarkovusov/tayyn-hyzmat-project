<script setup lang="ts">
import { onUnmounted, reactive, ref } from "vue";
import { adminApi, errorMessage } from "@/shared/api";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import type { District, Driver } from "../domain";
import { useResource } from "../useResource";
const emit = defineEmits<{ created: [driver: Driver] }>();
const form = reactive({
  fullName: "",
  phone: "+993",
  password: "",
  districtId: "",
});
const pending = ref(false),
  error = ref("");
let alive = true;
onUnmounted(() => {
  alive = false;
});
const {
  data: districts,
  error: regionError,
  loading,
  load,
} = useResource(
  async () => (await adminApi.get<District[]>("/districts")).data,
  [],
);
async function submit() {
  if (pending.value) return;
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
        <Input
          id="driver-phone"
          v-model="form.phone"
          type="tel"
          required
          minlength="6"
          maxlength="20"
          autocomplete="tel"
        />
      </div>
      <div class="field">
        <Label for="driver-password">Пароль</Label>
        <Input
          id="driver-password"
          v-model="form.password"
          type="password"
          required
          minlength="6"
          maxlength="128"
          autocomplete="new-password"
        />
        <p class="muted text-xs">
          Не менее 6 символов. Передайте пароль водителю.
        </p>
      </div>
      <div class="field">
        <Label for="driver-region">Район</Label>
        <select
          id="driver-region"
          v-model="form.districtId"
          class="native-select"
          required
          :disabled="loading"
        >
          <option value="" disabled>
            {{ loading ? "Загружаем…" : "Выберите район" }}
          </option>
          <option
            v-for="region in districts"
            :key="region.id"
            :value="region.id"
          >
            {{ region.name }}
          </option>
        </select>
        <p v-if="regionError" role="alert" class="text-sm text-destructive">
          {{ regionError }}
        </p>
        <Button v-if="regionError" type="button" variant="outline" @click="load"
          >Повторить</Button
        >
      </div>
    </fieldset>
    <p class="muted text-sm">
      Водитель будет одобрен. Начальный баланс: 0 TMT. Пополните его в карточке
      водителя для выхода на линию.
    </p>
    <p v-if="error" role="alert" class="text-sm text-destructive">
      {{ error }}
    </p>
    <Button
      type="submit"
      class="w-full"
      :disabled="pending || !form.districtId"
      >{{ pending ? "Добавляем…" : "Добавить водителя" }}</Button
    >
  </form>
</template>
