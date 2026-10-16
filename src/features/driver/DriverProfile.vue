<script setup lang="ts">
import IncomingOrder from "./components/IncomingOrder.vue";
import { onMounted, ref } from "vue";
import { Car, Wallet, ChevronLeft, ChevronRight } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { Badge } from "@/shared/ui/badge";
import { driverApi, errorMessage } from "@/shared/api";
import { useDriver } from "./useDriver";
import { date, money, statusLabels, type History } from "./model";
const { state } = useDriver();
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
onMounted(() => void load());
</script>
<template>
  <div class="mx-auto max-w-xl space-y-4">
    <h1 class="text-lg font-semibold">Профиль</h1>
    <IncomingOrder />
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
            {{ state.profile.user.phone }}
          </a>
        </div>
        <Badge
          :variant="
            state.profile?.status === 'BLOCKED' ? 'destructive' : 'secondary'
          "
        >
          {{
            state.profile?.status === "APPROVED"
              ? "Допущен"
              : state.profile?.status === "BLOCKED"
                ? "Заблокирован"
                : state.profile?.status === "PENDING"
                  ? "На проверке"
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
          <article
            v-for="order in history.orders.items"
            :key="order.id"
            class="space-y-2 p-4"
          >
            <div class="flex justify-between gap-3">
              <p class="min-w-0 break-words font-medium">
                {{ order.pickupAddress || "Адрес не указан" }}
              </p>
              <span class="shrink-0 tabular-nums">{{
                money(order.priceFinal ?? order.priceEstimated)
              }}</span>
            </div>
            <p v-if="order.dropoffAddress" class="muted break-words text-sm">
              {{ order.dropoffAddress }}
            </p>
            <div class="muted flex flex-wrap justify-between gap-2 text-xs">
              <span>{{ statusLabels[order.status] }}</span
              ><time>{{ date(order.createdAt) }}</time>
            </div>
          </article>
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
        <div class="flex items-center justify-between">
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
    <details class="rounded-xl border p-4">
      <summary class="cursor-pointer text-sm font-medium">
        Устройство и сеанс
      </summary>
      <p class="muted mt-3 text-sm">
        Этот сеанс работает в мобильном или настольном браузере. Выход из
        аккаунта доступен в меню приложения. Фоновые уведомления зависят от
        разрешений браузера.
      </p>
    </details>
  </div>
</template>
