<script setup lang="ts">
import IncomingOrder from "./components/IncomingOrder.vue";
import { onMounted, ref } from "vue";
import { Car, Wallet, ChevronLeft, ChevronRight } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
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
  <div class="mx-auto max-w-3xl space-y-6">
    <header>
      <h1 class="page-heading">Профиль</h1>
      <p class="muted mt-1">Ваш автомобиль, баланс и поездки.</p>
    </header>
    <IncomingOrder />
    <p v-if="state.error" role="alert" class="text-destructive">
      {{ state.error }}
    </p>
    <section class="panel">
      <h2 class="text-xl font-semibold">
        {{ state.profile?.user.fullName || "Загружаем профиль…" }}
      </h2>
      <p class="muted mt-1">{{ state.profile?.user.phone }}</p>
      <p class="mt-3 text-sm">
        Статус:
        {{
          state.profile?.status === "APPROVED"
            ? "Допущен к работе"
            : state.profile?.status || "Уточняем…"
        }}
      </p>
    </section>
    <div class="grid gap-4 sm:grid-cols-2">
      <section class="panel">
        <Wallet class="mb-3 size-5 text-primary" />
        <h2 class="font-medium">Тестовый баланс</h2>
        <p class="my-2 text-2xl font-semibold tabular-nums">
          {{ state.balance ? money(state.balance.amount) : "Загружаем…" }}
        </p>
        <p class="muted text-sm">
          Пополнение через диспетчера. Реальные платежи отключены.
        </p>
      </section>
      <section class="panel">
        <Car class="mb-3 size-5 text-primary" />
        <h2 class="font-medium">Автомобиль</h2>
        <template v-if="state.profile?.currentVehicle"
          ><p class="my-2 text-lg font-semibold">
            {{ state.profile.currentVehicle.plateNumber }}
          </p>
          <p class="muted text-sm">
            {{ state.profile.currentVehicle.make }}
            {{ state.profile.currentVehicle.model }}
            {{ state.profile.currentVehicle.color }}
          </p></template
        >
        <p v-else class="muted mt-2 text-sm">
          Автомобиль ещё не назначен. Обратитесь к диспетчеру.
        </p>
      </section>
    </div>
    <section class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-xl font-semibold">История</h2>
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
      <p v-if="loading" role="status" class="muted py-8 text-center">
        Загружаем историю…
      </p>
      <template v-else-if="history"
        ><div v-if="tab === 'orders'" class="divide-y rounded-xl border">
          <p v-if="!history.orders.items.length" class="muted p-8 text-center">
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
            class="muted p-8 text-center"
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
