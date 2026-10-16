<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  useAttrs,
  watch,
  watchEffect,
  type ComponentPublicInstance,
} from "vue";
import { Input } from "@/shared/ui/input";
import { formatLocalPhone, localPhoneInput, phoneError } from "@/shared/phone";

defineOptions({ inheritAttrs: false });
const props = defineProps<{
  id: string;
  modelValue: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const attrs = useAttrs();
const local = ref(localPhoneInput(props.modelValue));
const field = ref<ComponentPublicInstance>();
const displayed = computed(() => formatLocalPhone(local.value));
let editVersion = 0;
const touched = ref(false);
let lastEmitted: string | undefined;
const invalid = computed(() => !/^[0-9]{8}$/.test(local.value));
const showError = computed(() => touched.value && invalid.value);
const descriptionId = computed(() => `${props.id}-phone-hint`);
const describedBy = computed(() =>
  [attrs["aria-describedby"], descriptionId.value].filter(Boolean).join(" "),
);
watch(
  () => props.modelValue,
  (value) => {
    if (value !== lastEmitted) {
      editVersion++;
      local.value = localPhoneInput(value);
    }
  },
);
watchEffect(
  () => {
    const message = invalid.value ? phoneError : "";
    (field.value?.$el as HTMLInputElement | undefined)?.setCustomValidity(
      message,
    );
  },
  { flush: "post" },
);
function digitPosition(value: string, cursor: number): number {
  const compact = value.replace(/[\s()-]/g, "");
  const prefixDigits = compact.startsWith("+993")
    ? 3
    : /^00993[0-9]{8}$/.test(compact)
      ? 5
      : 0;
  return Math.max(
    0,
    value.slice(0, cursor).replace(/[^0-9]/g, "").length - prefixDigits,
  );
}
function formattedPosition(digits: number): number {
  return digits + Math.max(0, Math.floor((digits - 1) / 2));
}
function applyEdit(input: HTMLInputElement, value: string, cursor: number) {
  const version = ++editVersion;
  local.value = value;
  touched.value = true;
  const text = displayed.value;
  const position = Math.min(cursor, text.length);
  const restore = () => {
    if (version !== editVersion) return;
    input.value = text;
    input.setSelectionRange(position, position);
  };
  restore();
  input.setCustomValidity(invalid.value ? phoneError : "");
  lastEmitted = /^[0-9]{0,8}$/.test(local.value) ? `+993${local.value}` : "";
  emit("update:modelValue", lastEmitted);
  // The official Input also owns a native model. Reconcile its render without
  // moving a middle selection, including paste that normalizes to the same model.
  void nextTick(restore);
}
function update(event: Event) {
  const input = event.target as HTMLInputElement;
  const raw = input.value;
  const cursor = input.selectionStart ?? raw.length;
  const normalized = localPhoneInput(raw);
  const formatted = formatLocalPhone(normalized);
  const position =
    formatted === raw
      ? cursor
      : /^[0-9]{0,8}$/.test(normalized)
        ? formattedPosition(digitPosition(raw, cursor))
        : cursor;
  applyEdit(input, normalized, position);
}
function beforeInput(event: Event) {
  const edit = event as InputEvent;
  const input = event.target as HTMLInputElement;
  const cursor = input.selectionStart;
  if (
    cursor === null ||
    cursor !== input.selectionEnd ||
    !/^[0-9]{0,8}$/.test(local.value)
  )
    return;
  const backwards =
    edit.inputType === "deleteContentBackward" &&
    input.value[cursor - 1] === " ";
  const forwards =
    edit.inputType === "deleteContentForward" && input.value[cursor] === " ";
  if (!backwards && !forwards) return;
  event.preventDefault();
  const digitsBefore = digitPosition(input.value, cursor);
  const index = backwards ? digitsBefore - 1 : digitsBefore;
  const next = local.value.slice(0, index) + local.value.slice(index + 1);
  applyEdit(input, next, formattedPosition(index));
}
</script>
<template>
  <div class="space-y-1.5">
    <div
      class="flex h-9 items-center rounded-md border border-input bg-transparent shadow-sm focus-within:ring-1 focus-within:ring-ring"
      :class="{ 'opacity-50': disabled }"
    >
      <span
        aria-hidden="true"
        class="select-none pl-3 text-sm text-muted-foreground"
        >+993</span
      >
      <Input
        ref="field"
        v-bind="$attrs"
        :id="id"
        :model-value="displayed"
        :disabled="disabled"
        type="tel"
        inputmode="tel"
        autocomplete="tel-national"
        pattern="[0-9]{2} [0-9]{2} [0-9]{2} [0-9]{2}"
        placeholder="65 99 54 24"
        :aria-invalid="showError ? 'true' : undefined"
        :aria-describedby="describedBy"
        class="min-w-0 rounded-none border-0 pl-2 shadow-none focus-visible:ring-0"
        @input="update"
        @beforeinput="beforeInput"
        @invalid="touched = true"
        @blur="touched = local.length > 0"
      />
    </div>
    <p
      :id="descriptionId"
      class="text-xs"
      :class="showError ? 'text-destructive' : 'sr-only'"
      :role="showError ? 'alert' : undefined"
    >
      {{ showError ? phoneError : "Код страны +993. Введите 8 цифр номера." }}
    </p>
  </div>
</template>
