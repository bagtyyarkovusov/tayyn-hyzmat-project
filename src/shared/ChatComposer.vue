<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { Send } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";
const model = defineModel<string>({ required: true });
const props = defineProps<{ label: string; pending: boolean }>();
const emit = defineEmits<{ send: [] }>();
const form = ref<HTMLElement>();
watch(model, async () => {
  await nextTick();
  const input = form.value?.querySelector("textarea");
  if (input) {
    input.style.height = "auto";
    input.style.height = `${Math.min(112, input.scrollHeight)}px`;
  }
});
function submit() {
  if (!props.pending && model.value.trim()) emit("send");
}
function keydown(event: KeyboardEvent) {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.isComposing ||
    event.keyCode === 229
  )
    return;
  event.preventDefault();
  submit();
}
</script>
<template>
  <form ref="form" class="chat-composer" @submit.prevent="submit">
    <Textarea
      v-model="model"
      :aria-label="label"
      :placeholder="label"
      rows="1"
      maxlength="2000"
      enterkeyhint="send"
      :readonly="pending"
      class="min-h-11 max-h-28 resize-none text-base"
      @keydown="keydown"
    />
    <Button
      type="submit"
      size="icon"
      class="size-11 shrink-0"
      :disabled="pending || !model.trim()"
      aria-label="Отправить сообщение"
      ><Send class="size-5"
    /></Button>
  </form>
</template>
<style scoped>
.chat-composer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
  padding: 0.75rem;
  border-top: 1px solid var(--border);
  background: var(--card);
}
</style>
