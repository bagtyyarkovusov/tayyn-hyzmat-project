<script setup lang="ts">
import { formatPhone } from "@/shared/phone";
import { computed, ref } from "vue";
import { Phone, Navigation, MapPin, Flag } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/shared/ui/dialog";
import { Textarea } from "@/shared/ui/textarea";
import { useDriver } from "../useDriver";
import { money, statusLabels } from "../model";
defineProps<{ embedded?: boolean }>();
const { state, transition } = useDriver();
const cancelOpen = ref(false);
const reason = ref("");
const navigation = computed(() => {
  const o = state.active;
  if (!o) return "";
  const drop =
    o.status === "STARTED" && o.dropoffLat != null && o.dropoffLng != null;
  const lat = drop ? o.dropoffLat : o.pickupLat;
  const lng = drop ? o.dropoffLng : o.pickupLng;
  return lat != null && lng != null
    ? `https://yandex.ru/maps/?rtext=~${lat},${lng}&rtt=auto`
    : "";
});
async function cancel() {
  await transition("cancel", reason.value.trim() || "Отменено водителем");
  if (!state.active) cancelOpen.value = false;
}
</script>
<template>
  <section
    v-if="state.active"
    class="space-y-4"
    :class="embedded ? 'pt-8' : 'panel border-primary/40'"
    aria-labelledby="trip-title"
  >
    <div class="flex items-start justify-between gap-4">
      <div>
        <p class="text-sm font-medium text-primary">
          {{ statusLabels[state.active.status] }}
        </p>
        <h2 id="trip-title" class="text-xl font-semibold">Текущая поездка</h2>
      </div>
      <span class="font-semibold tabular-nums">{{
        money(state.active.priceEstimated)
      }}</span>
    </div>
    <div class="space-y-4">
      <div class="flex gap-3">
        <MapPin class="mt-1 size-5 shrink-0 text-primary" />
        <div>
          <p class="muted text-xs">Откуда</p>
          <p class="font-medium break-words">
            {{ state.active.pickupAddress || "Подача уточняется по телефону" }}
          </p>
        </div>
      </div>
      <div v-if="state.active.dropoffAddress" class="flex gap-3">
        <Flag class="mt-1 size-5 shrink-0 text-muted-foreground" />
        <div>
          <p class="muted text-xs">Куда</p>
          <p class="font-medium break-words">
            {{ state.active.dropoffAddress }}
          </p>
        </div>
      </div>
    </div>
    <p
      v-if="state.active.note"
      class="rounded-lg bg-muted p-3 text-sm break-words"
    >
      {{ state.active.note }}
    </p>
    <p v-if="state.active.etaMinutes" class="muted text-sm">
      Прибытие: {{ state.active.etaMinutes }} мин
    </p>
    <div class="flex flex-wrap gap-2">
      <Button v-if="state.active.clientPhone" as-child variant="outline"
        ><a :href="`tel:${state.active.clientPhone}`"
          ><Phone class="size-4" />{{
            formatPhone(state.active.clientPhone)
          }}</a
        ></Button
      ><Button v-if="navigation" as-child variant="outline"
        ><a :href="navigation" target="_blank" rel="noopener"
          ><Navigation class="size-4" />Ориентир на карте</a
        ></Button
      >
    </div>
    <p class="muted text-xs">
      Позвоните клиенту и уточните подачу. Точка на карте может быть центром
      района, а не точным местом клиента.
    </p>
    <div class="grid gap-2 sm:grid-cols-[1fr_auto]">
      <Button
        v-if="state.active.status === 'ACCEPTED'"
        :disabled="state.busy"
        @click="transition('waiting')"
        >{{ state.busy ? "Сохраняем…" : "Я на месте" }}</Button
      ><Button
        v-if="state.active.status === 'WAITING'"
        :disabled="state.busy"
        @click="transition('start')"
        >Начать поездку</Button
      ><Button
        v-if="state.active.status === 'STARTED'"
        :disabled="state.busy"
        @click="transition('complete')"
        >Завершить поездку</Button
      ><Button
        v-if="state.active.status === 'WAITING'"
        variant="ghost"
        :disabled="state.busy"
        @click="cancelOpen = true"
        >Отменить заказ</Button
      >
    </div>
    <Dialog v-model:open="cancelOpen"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>Отменить текущий заказ?</DialogTitle
          ><DialogDescription
            >Заказ будет закрыт. Списание за принятие заказа вернётся на
            баланс.</DialogDescription
          ></DialogHeader
        ><label for="cancel-reason" class="field-label">Причина отмены</label
        ><Textarea
          id="cancel-reason"
          v-model="reason"
          maxlength="500"
          placeholder="Необязательно"
        /><DialogFooter
          ><Button variant="outline" @click="cancelOpen = false"
            >Продолжить поездку</Button
          ><Button variant="destructive" :disabled="state.busy" @click="cancel"
            >Подтвердить отмену</Button
          ></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </section>
</template>
