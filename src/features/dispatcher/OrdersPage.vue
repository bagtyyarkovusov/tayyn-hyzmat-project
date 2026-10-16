<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import { Plus } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/shared/ui/dialog";
import { adminApi, errorMessage } from "@/shared/api";
import type { Order, Page } from "./domain";
import { useResource } from "./useResource";
import OrderCard from "./components/OrderCard.vue";
import PageState from "./components/PageState.vue";
import PrivateOfferForm from "./components/PrivateOfferForm.vue";
import CreateOrderForm from "./components/CreateOrderForm.vue";
const route = useRoute();
const filter = ref("active"),
  page = ref(1),
  create = ref(route.query.create === "1"),
  offer = ref<Order | null>(null),
  cancel = ref<Order | null>(null),
  resolve = ref<Order | null>(null),
  reason = ref(""),
  pending = ref(false),
  actionError = ref("");
const filters = [
  { value: "active", label: "Активные" },
  { value: "accepted", label: "Принятые" },
  { value: "completed", label: "Завершённые" },
  { value: "cancelled", label: "Отменённые" },
  { value: "all", label: "Все" },
];
const { data, loading, error, load } = useResource(
  async () =>
    (
      await adminApi.get<Page<Order>>("/admin/orders", {
        params: { status: filter.value, page: page.value, limit: 20 },
      })
    ).data,
  { items: [], total: 0, page: 1, limit: 20 },
  [
    "order:new",
    "order:private-offer",
    "order:updated",
    "order:private-offer-ended",
    "order:accepted",
    "order:waiting",
    "order:started",
    "order:completed",
    "order:cancelled",
  ],
);
watch(filter, () => {
  page.value = 1;
  void load();
});
watch(page, () => {
  void load();
});
async function confirmCancel() {
  if (!cancel.value) return;
  pending.value = true;
  actionError.value = "";
  try {
    await adminApi.post(`/admin/orders/${cancel.value.id}/cancel`, {
      reason: reason.value,
    });
    cancel.value = null;
    reason.value = "";
    await load();
  } catch (e) {
    actionError.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}
async function confirmResolve() {
  if (!resolve.value || !reason.value.trim()) {
    actionError.value = "Укажите причину";
    return;
  }
  pending.value = true;
  actionError.value = "";
  try {
    await adminApi.post(`/admin/orders/${resolve.value.id}/force-resolve`, {
      reason: reason.value,
    });
    resolve.value = null;
    reason.value = "";
    await load();
  } catch (e) {
    actionError.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <div class="space-y-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="page-heading">
          Заказы <span class="text-muted-foreground">{{ data.total }}</span>
        </h1>
      </div>
      <Button @click="create = true"
        ><Plus class="size-4" />Создать заказ</Button
      >
    </header>
    <div class="flex flex-wrap gap-2" aria-label="Фильтр заказов">
      <Button
        v-for="item in filters"
        :key="item.value"
        :variant="filter === item.value ? 'default' : 'outline'"
        size="sm"
        :aria-pressed="filter === item.value"
        @click="filter = item.value"
        >{{ item.label }}</Button
      >
    </div>
    <PageState
      :loading="loading"
      :error="error"
      :empty="!data.items.length"
      empty-title="Заказов с этим статусом нет"
      empty-description="Измените фильтр или создайте новый заказ."
      @retry="load"
    />
    <div v-if="!loading && !error" class="grid gap-4 xl:grid-cols-2">
      <OrderCard
        v-for="order in data.items"
        :key="order.id"
        :order="order"
        cancellable
        offerable
        @offer="offer = $event"
        @cancel="
          cancel = $event;
          actionError = '';
        "
        @resolve="
          resolve = $event;
          reason = '';
          actionError = '';
        "
      />
    </div>
    <div v-if="data.total > 20" class="flex items-center justify-between">
      <Button
        variant="outline"
        :disabled="page === 1 || loading"
        @click="page--"
        >Назад</Button
      ><span class="text-sm text-muted-foreground"
        >Страница {{ page }} из {{ Math.ceil(data.total / 20) }}</span
      ><Button
        variant="outline"
        :disabled="page * 20 >= data.total || loading"
        @click="page++"
        >Далее</Button
      >
    </div>
    <Dialog :open="!!offer" @update:open="!$event && (offer = null)"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>Предложить заказ водителю</DialogTitle
          ><DialogDescription
            >Заказ будет доступен выбранному водителю 20 секунд. При отказе или
            без ответа вернётся в свой район.</DialogDescription
          ></DialogHeader
        ><PrivateOfferForm
          v-if="offer"
          :order-id="offer.id"
          :price-estimated="offer.priceEstimated"
          @offered="
            offer = null;
            load();
          " /></DialogContent
    ></Dialog>
    <Dialog v-model:open="create"
      ><DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        ><DialogHeader
          ><DialogTitle>Новый заказ</DialogTitle
          ><DialogDescription
            >Выберите район, укажите телефон и стоимость в TMT. Остальные
            сведения необязательны.</DialogDescription
          ></DialogHeader
        ><CreateOrderForm
          @created="
            create = false;
            load();
          " /></DialogContent></Dialog
    ><Dialog
      :open="!!cancel"
      @update:open="!$event && !pending && (cancel = null)"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>Отменить заказ?</DialogTitle
          ><DialogDescription
            >Заказ #{{ cancel?.id.slice(0, 8) }} будет закрыт. Водитель получит
            уведомление.</DialogDescription
          ></DialogHeader
        ><Label for="cancel-reason">Причина, необязательно</Label
        ><Textarea id="cancel-reason" v-model="reason" maxlength="500" />
        <p v-if="actionError" role="alert" class="text-sm text-destructive">
          {{ actionError }}
        </p>
        <DialogFooter
          ><Button variant="outline" :disabled="pending" @click="cancel = null"
            >Оставить заказ</Button
          ><Button
            variant="destructive"
            :disabled="pending"
            @click="confirmCancel"
            >{{ pending ? "Отменяем…" : "Отменить заказ" }}</Button
          ></DialogFooter
        ></DialogContent
      ></Dialog
    ><Dialog
      :open="!!resolve"
      @update:open="!$event && !pending && (resolve = null)"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>Завершить поездку вручную?</DialogTitle
          ><DialogDescription
            >Используйте после проверки поездки. Заказ останется за водителем в
            истории, а списание не изменится.</DialogDescription
          ></DialogHeader
        ><Label for="resolve-reason">Причина обязательна</Label
        ><Textarea
          id="resolve-reason"
          v-model="reason"
          maxlength="500"
          placeholder="Например: клиент подтвердил завершение по телефону"
        />
        <p v-if="actionError" role="alert" class="text-sm text-destructive">
          {{ actionError }}
        </p>
        <DialogFooter
          ><Button variant="outline" :disabled="pending" @click="resolve = null"
            >Оставить в пути</Button
          ><Button
            variant="destructive"
            :disabled="pending || !reason.trim()"
            @click="confirmResolve"
            >{{ pending ? "Завершаем…" : "Завершить поездку" }}</Button
          ></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </div>
</template>
