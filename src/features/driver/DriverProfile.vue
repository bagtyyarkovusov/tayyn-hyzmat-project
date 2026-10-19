<script setup lang="ts">
import { formatPhone } from "@/shared/phone";
import { onMounted, ref, watch } from "vue";
import {
  Car,
  Wallet,
  LogOut,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-vue-next";
import { useRouter } from "vue-router";

import { Button } from "@/shared/ui/button";
import { Badge } from "@/shared/ui/badge";
import { driverApi, errorMessage } from "@/shared/api";
import { useDriver } from "./useDriver";

import { date, money, statusLabels, type History } from "./model";
const { state, session } = useDriver();
const router = useRouter();
async function logout() {
  await session.logout();
  await router.replace("/driverLogin");
}
const history = ref<History | null>(null),
  loading = ref(false),
  error = ref(""),
  page = ref(1);
const tab = ref<"orders" | "transactions">("orders");
const labels: Record<string, string> = {
  TOPUP: "Пополнение",
  EARNING: "Начисление",
  COMMISSION: "Комиссия",
  PAYMENT: "Оплата поездки",
  WITHDRAWAL: "Списание",
  REFUND: "Возврат",
  BONUS: "Бонус",
  ADJUSTMENT: "Корректировка",
};
async function load(next = page.value) {
  loading.value = true;
  error.value = "";
  try {
    const { data } = await driverApi.get<History>("/driver/history", {
      params: { page: next, limit: 20 },
    });
    history.value = data;
    page.value = next;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
watch(tab, () => void load(1));
onMounted(() => void load());
</script>
<template>
  <div class="mx-auto max-w-xl space-y-4">
    <h1 class="text-lg font-semibold">Профиль</h1>
    <p v-if="state.error" role="alert" class="text-sm text-destructive">
      {{ state.error }}
    </p>
    <section
      aria-label="Данные водителя"
      class="divide-y overflow-hidden rounded-xl border bg-card"
    >
      <div class="flex flex-wrap items-start justify-between gap-2 p-4">
        <div class="min-w-0">
          <h2 class="break-words font-semibold">
            {{ state.profile?.user.fullName || "Загружаем профиль…" }}
          </h2>
          <a
            v-if="state.profile"
            :href="`tel:${state.profile.user.phone}`"
            class="mt-1 inline-block text-sm text-muted-foreground"
          >
            {{ formatPhone(state.profile.user.phone) }}
          </a>
        </div>
        <Badge
          :variant="
            state.profile?.status === 'BLOCKED' ? 'destructive' : 'secondary'
          "
        >
          {{
            state.profile?.status === "APPROVED"
              ? "Активен"
              : state.profile?.status === "BLOCKED"
                ? "Заблокирован"
                : state.profile?.status === "PENDING"
                  ? "Доступ ограничен"
                  : "Загружаем…"
          }}
        </Badge>
      </div>
      <div class="flex items-center gap-3 px-4 py-3">
        <Wallet class="size-4 shrink-0 text-primary" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-medium">Баланс</h2>
          <p class="mt-0.5 text-xs text-muted-foreground">
            Пополнение через диспетчера
          </p>
        </div>
        <p class="shrink-0 text-lg font-semibold tabular-nums">
          {{ state.balance ? money(state.balance.amount) : "…" }}
        </p>
      </div>
      <div class="flex items-start gap-3 px-4 py-3">
        <Car class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-medium">Автомобиль</h2>
          <template v-if="state.profile?.currentVehicle">
            <p class="mt-1 break-words text-sm font-semibold">
              {{ state.profile.currentVehicle.plateNumber }}
            </p>
            <p class="break-words text-xs text-muted-foreground">
              {{ state.profile.currentVehicle.make }}
              {{ state.profile.currentVehicle.model }}
              {{ state.profile.currentVehicle.color }}
            </p>
          </template>
          <p v-else class="mt-0.5 text-xs text-muted-foreground">
            Не назначен. Обратитесь к диспетчеру.
          </p>
        </div>
      </div>
    </section>
    <Button variant="outline" class="min-h-12 w-full" @click="logout"
      ><LogOut class="size-5" />Выйти</Button
    >
    <section class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="font-semibold">История</h2>
        <div class="flex gap-1" role="group" aria-label="Тип истории">
          <Button
            :variant="tab === 'orders' ? 'default' : 'outline'"
            :aria-pressed="tab === 'orders'"
            @click="tab = 'orders'"
            >Поездки</Button
          ><Button
            :variant="tab === 'transactions' ? 'default' : 'outline'"
            :aria-pressed="tab === 'transactions'"
            @click="tab = 'transactions'"
            >Баланс</Button
          >
        </div>
      </div>
      <p v-if="error" role="alert" class="text-destructive">
        {{ error }} <Button variant="link" @click="load()">Повторить</Button>
      </p>
      <p v-if="loading" role="status" class="muted py-4 text-center text-sm">
        Загружаем историю…
      </p>
      <template v-else-if="history"
        ><div v-if="tab === 'orders'" class="divide-y rounded-xl border">
          <p
            v-if="!history.orders.items.length"
            class="muted p-4 text-center text-sm"
          >
            Поездок пока нет.
          </p>
          <details
            v-for="order in history.orders.items"
            :key="order.id"
            class="group"
          >
            <summary
              class="flex min-h-11 cursor-pointer list-none items-start gap-3 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden"
            >
              <div class="min-w-0 flex-1 space-y-1.5">
                <div class="flex items-start justify-between gap-3">
                  <span class="min-w-0 break-words font-medium">
                    {{ order.pickupAddress || "Место подачи не указано" }}
                  </span>
                  <span class="shrink-0 font-semibold tabular-nums">
                    {{
                      order.priceFinal != null || order.priceEstimated != null
                        ? money(order.priceFinal ?? order.priceEstimated)
                        : "Цена не указана"
                    }}
                  </span>
                </div>
                <div
                  class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
                >
                  <span
                    :class="
                      order.status === 'CANCELLED'
                        ? 'text-destructive'
                        : 'text-foreground'
                    "
                  >
                    {{ statusLabels[order.status] }}
                  </span>
                  <span v-if="order.district?.name">{{
                    order.district.name
                  }}</span>
                  <time :datetime="order.createdAt">{{
                    date(order.createdAt)
                  }}</time>
                </div>
              </div>
              <ChevronDown
                class="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
                aria-hidden="true"
              />
              <span class="sr-only">Подробности поездки</span>
            </summary>
            <div class="space-y-4 px-4 pb-4 text-sm">
              <dl class="space-y-3 border-t pt-3">
                <div>
                  <dt class="text-xs text-muted-foreground">Откуда</dt>
                  <dd class="mt-0.5 break-words">
                    {{ order.pickupAddress || "Точный адрес не указан" }}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs text-muted-foreground">Куда</dt>
                  <dd class="mt-0.5 break-words">
                    {{ order.dropoffAddress || "Место назначения не указано" }}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs text-muted-foreground">Номер заказа</dt>
                  <dd class="mt-0.5 font-medium">#{{ order.orderNumber }}</dd>
                </div>
                <div v-if="order.note">
                  <dt class="text-xs text-muted-foreground">Примечание</dt>
                  <dd class="mt-0.5 whitespace-pre-wrap break-words">
                    {{ order.note }}
                  </dd>
                </div>
                <div v-if="order.cancelReason">
                  <dt class="text-xs text-muted-foreground">Причина отмены</dt>
                  <dd class="mt-0.5 whitespace-pre-wrap break-words">
                    {{ order.cancelReason }}
                  </dd>
                </div>
              </dl>
              <dl
                class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 border-t pt-3 text-xs"
              >
                <dt class="text-muted-foreground">Создан</dt>
                <dd>
                  <time :datetime="order.createdAt">{{
                    date(order.createdAt)
                  }}</time>
                </dd>
                <template v-if="order.acceptedAt">
                  <dt class="text-muted-foreground">Принят</dt>
                  <dd>
                    <time :datetime="order.acceptedAt">{{
                      date(order.acceptedAt)
                    }}</time>
                  </dd>
                </template>
                <template v-if="order.arrivedAt">
                  <dt class="text-muted-foreground">На месте</dt>
                  <dd>
                    <time :datetime="order.arrivedAt">{{
                      date(order.arrivedAt)
                    }}</time>
                  </dd>
                </template>
                <template v-if="order.startedAt">
                  <dt class="text-muted-foreground">Начало поездки</dt>
                  <dd>
                    <time :datetime="order.startedAt">{{
                      date(order.startedAt)
                    }}</time>
                  </dd>
                </template>
                <template v-if="order.completedAt">
                  <dt class="text-muted-foreground">Завершён</dt>
                  <dd>
                    <time :datetime="order.completedAt">{{
                      date(order.completedAt)
                    }}</time>
                  </dd>
                </template>
                <template v-if="order.cancelledAt">
                  <dt class="text-muted-foreground">Отменён</dt>
                  <dd>
                    <time :datetime="order.cancelledAt">{{
                      date(order.cancelledAt)
                    }}</time>
                  </dd>
                </template>
              </dl>
            </div>
          </details>
        </div>
        <div v-else class="divide-y rounded-xl border">
          <p
            v-if="!history.transactions.items.length"
            class="muted p-4 text-center text-sm"
          >
            Операций пока нет.
          </p>
          <article
            v-for="tx in history.transactions.items"
            :key="tx.id"
            class="flex justify-between gap-3 p-4"
          >
            <div class="min-w-0">
              <p class="font-medium">{{ labels[tx.type] || tx.type }}</p>
              <p class="muted mt-1 text-xs">{{ date(tx.createdAt) }}</p>
              <p v-if="tx.note" class="muted mt-1 break-words text-sm">
                {{ tx.note }}
              </p>
            </div>
            <div class="shrink-0 text-right tabular-nums">
              <p
                :class="
                  Number(tx.amount) < 0 ? 'text-destructive' : 'text-primary'
                "
              >
                {{ Number(tx.amount) > 0 ? "+" : "" }}{{ money(tx.amount) }}
              </p>
              <p class="muted mt-1 text-xs">
                Остаток {{ money(tx.balanceAfter) }}
              </p>
            </div>
          </article>
        </div>
        <div
          v-if="history[tab].total > 20"
          class="flex items-center justify-between"
        >
          <Button
            variant="outline"
            :disabled="page === 1 || loading"
            @click="load(page - 1)"
            ><ChevronLeft class="size-4" />Назад</Button
          ><span class="muted text-sm">Страница {{ page }}</span
          ><Button
            variant="outline"
            :disabled="page * 20 >= history[tab].total || loading"
            @click="load(page + 1)"
            >Далее<ChevronRight class="size-4"
          /></Button></div
      ></template>
    </section>
    <p
      v-if="state.profile?.canControlShift === false"
      role="status"
      class="text-sm text-muted-foreground"
    >
      Смена работает на другом устройстве. Здесь доступны просмотр и чат. Чтобы
      работать с этого устройства, сначала завершите смену на другом.
    </p>
  </div>
</template>
