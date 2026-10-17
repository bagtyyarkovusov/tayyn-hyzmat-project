<script setup lang="ts">
import { useLocationAddress } from "@/shared/useLocationAddress";
import { formatPhone } from "@/shared/phone";
import { ref, watch, onMounted, onUnmounted } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { ArrowLeft } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import PhoneInput from "@/shared/ui/phone-input/PhoneInput.vue";
import { passwordError, passwordHint } from "@/shared/password";
import { Label } from "@/shared/ui/label";
import { Badge } from "@/shared/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/shared/ui/dialog";
import { adminSession } from "@/features/auth/session";
import { adminApi, errorMessage } from "@/shared/api";
import {
  money,
  date,
  statusLabel,
  transactionLabel,
  type Driver,
  type History,
} from "./domain";
import { useResource } from "./useResource";
import PageState from "./components/PageState.vue";
import OrderCard from "./components/OrderCard.vue";
const props = defineProps<{ driverId: string }>(),
  router = useRouter();
const tab = ref("info"),
  pending = ref(false),
  actionError = ref(""),
  notice = ref(""),
  confirm = ref(""),
  reason = ref(""),
  amount = ref(""),
  note = ref(""),
  historyPage = ref(1);
const credentialDialog = ref<"" | "profile" | "password">("");
const identity = ref({ fullName: "", phone: "+993" });
const newPassword = ref("");
const passwordConfirmation = ref("");
const credentialError = ref("");
const credentialPending = ref(false);
let credentialGeneration = 0;
function closeCredentials() {
  credentialGeneration++;
  credentialDialog.value = "";
  newPassword.value = "";
  passwordConfirmation.value = "";
  credentialError.value = "";
  credentialPending.value = false;
}
function openCredentials(kind: "profile" | "password") {
  closeCredentials();
  identity.value = {
    fullName: driver.value?.user.fullName || "",
    phone: driver.value?.user.phone || "+993",
  };
  credentialDialog.value = kind;
}
watch(() => [props.driverId, adminSession.state.user?.id], closeCredentials);
onUnmounted(closeCredentials);
async function saveCredentials() {
  if (credentialPending.value) return;
  credentialError.value = "";
  if (
    credentialDialog.value === "password" &&
    newPassword.value !== passwordConfirmation.value
  ) {
    credentialError.value = "Пароли не совпадают";
    return;
  }
  if (
    credentialDialog.value === "password" &&
    passwordError(newPassword.value)
  ) {
    credentialError.value = passwordError(newPassword.value);
    return;
  }
  const generation = credentialGeneration;
  const driverId = props.driverId;
  const kind = credentialDialog.value;
  credentialPending.value = true;
  try {
    await adminApi.post(
      `/admin/drivers/${driverId}/${kind}`,
      kind === "profile"
        ? { ...identity.value }
        : {
            password: newPassword.value,
            passwordConfirmation: passwordConfirmation.value,
          },
    );
    if (generation !== credentialGeneration) return;
    closeCredentials();
    notice.value = "Данные сохранены";
    await load();
  } catch (error) {
    if (generation === credentialGeneration)
      credentialError.value = errorMessage(error);
  } finally {
    if (generation === credentialGeneration) credentialPending.value = false;
  }
}
const vehicle = ref({ plateNumber: "", make: "", model: "", color: "" });
const {
  data: driver,
  loading,
  error,
  load,
} = useResource(
  async () =>
    (await adminApi.get<Driver>(`/admin/drivers/${props.driverId}`)).data,
  null as Driver | null,
  ["driver:status", "driver:updated", "balance:updated"],
);
const { data: history, load: loadHistory } = useResource(
  async () =>
    (
      await adminApi.get<History>(`/admin/drivers/${props.driverId}/history`, {
        params: { page: historyPage.value, limit: 20 },
      })
    ).data,
  null as History | null,
  ["balance:updated", "order:completed"],
);
let offLocation: (() => void) | undefined;
function refreshVisibleLocation() {
  if (!document.hidden && tab.value === "info") void load();
}
onMounted(() => {
  offLocation = adminSession.on(
    "driver:location",
    (event: { driverId: string }) => {
      if (event.driverId === props.driverId) refreshVisibleLocation();
    },
  );
  document.addEventListener("visibilitychange", refreshVisibleLocation);
});
onUnmounted(() => {
  offLocation?.();
  document.removeEventListener("visibilitychange", refreshVisibleLocation);
});
watch(tab, () => {
  if (tab.value === "info") refreshVisibleLocation();
});
const gpsAddress = useLocationAddress(
  () =>
    driver.value?.lastLat != null &&
    driver.value?.lastLng != null &&
    driver.value.lastLocationAt &&
    Date.now() - new Date(driver.value.lastLocationAt).getTime() < 60_000
      ? { lat: Number(driver.value.lastLat), lng: Number(driver.value.lastLng) }
      : null,
  () => (adminSession.state.user ? props.driverId : undefined),
  adminApi,
  () => tab.value === "info",
);
watch(driver, (d, previous) => {
  // GPS/profile refreshes must not replace a dispatcher’s vehicle draft.
  if (
    d &&
    (d.id !== previous?.id ||
      (["plateNumber", "make", "model", "color"] as const).some(
        (key) => d.currentVehicle?.[key] !== previous?.currentVehicle?.[key],
      ))
  )
    vehicle.value = {
      plateNumber: d.currentVehicle?.plateNumber || "",
      make: d.currentVehicle?.make || "",
      model: d.currentVehicle?.model || "",
      color: d.currentVehicle?.color || "",
    };
});
watch(
  () => props.driverId,
  () => {
    historyPage.value = 1;
    void load();
    void loadHistory();
  },
);
watch(historyPage, () => {
  void loadHistory();
});
async function act(action: string, body?: unknown) {
  pending.value = true;
  actionError.value = "";
  notice.value = "";
  try {
    if (action === "delete") {
      await adminApi.delete(`/admin/drivers/${props.driverId}`);
      await router.push("/adminDrivers");
      return;
    }
    await adminApi.post(`/admin/drivers/${props.driverId}/${action}`, body);
    if (action === "balance") walletIntent = null;
    confirm.value = "";
    notice.value = "Изменения сохранены";
    await Promise.all([load(), loadHistory()]);
  } catch (e) {
    actionError.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}
// Keep one durable command ID across a lost response or a deliberate retry.
let walletIntent: { fingerprint: string; operationId: string } | null = null;
watch([() => props.driverId, amount, note], () => {
  walletIntent = null;
});
function adjust(withdraw: boolean) {
  if (
    pending.value ||
    !Number.isFinite(Number(amount.value)) ||
    Number(amount.value) <= 0
  )
    return;
  const body = {
    amount: Number(amount.value) * (withdraw ? -1 : 1),
    type: withdraw ? "WITHDRAWAL" : "TOPUP",
    note: note.value,
  };
  const fingerprint = JSON.stringify({ driverId: props.driverId, ...body });
  if (!walletIntent || walletIntent.fingerprint !== fingerprint)
    walletIntent = { fingerprint, operationId: crypto.randomUUID() };
  void act("balance", { ...body, operationId: walletIntent.operationId });
}
</script>
<template>
  <div class="space-y-6">
    <RouterLink
      to="/adminDrivers"
      class="inline-flex items-center gap-2 text-sm text-muted-foreground"
      ><ArrowLeft class="size-4" />Все водители</RouterLink
    ><PageState :loading="loading" :error="error" @retry="load" /><template
      v-if="driver"
      ><header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="page-heading">{{ driver.user.fullName }}</h1>
          <a
            :href="`tel:${driver.user.phone}`"
            class="mt-2 inline-block text-muted-foreground"
            >{{ formatPhone(driver.user.phone) }}</a
          >
        </div>
        <Badge
          :variant="driver.status === 'BLOCKED' ? 'destructive' : 'secondary'"
          >{{ statusLabel(driver.status) }}</Badge
        >
      </header>
      <div class="flex flex-wrap gap-2">
        <Button
          v-for="item in [
            { id: 'info', label: 'Профиль' },
            { id: 'balance', label: 'Баланс' },
            { id: 'history', label: 'Поездки' },
          ]"
          :key="item.id"
          :variant="tab === item.id ? 'default' : 'outline'"
          :aria-pressed="tab === item.id"
          @click="tab = item.id"
          >{{ item.label }}</Button
        ><Button variant="outline" as-child
          ><RouterLink :to="`/adminChat/${driverId}`"
            >Написать водителю</RouterLink
          ></Button
        >
      </div>
      <p v-if="actionError" role="alert" class="text-sm text-destructive">
        {{ actionError }}
      </p>
      <p v-if="notice" role="status" class="text-sm text-primary">
        {{ notice }}
      </p>
      <div v-if="tab === 'info'" class="flex flex-wrap gap-2">
        <Button variant="outline" @click="openCredentials('profile')"
          >Изменить данные входа</Button
        >
        <Button variant="outline" @click="openCredentials('password')"
          >Сбросить пароль</Button
        >
      </div>
      <section
        v-if="tab === 'info'"
        class="grid gap-x-8 gap-y-6 xl:grid-cols-2"
      >
        <div class="space-y-6">
          <div class="border-b pb-5">
            <h2 class="mb-3 font-semibold">На связи</h2>
            <dl
              class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm [&_dd]:break-words"
            >
              <div>
                <dt class="text-muted-foreground">Район</dt>
                <dd class="mt-1">{{ driver.district?.name || "Не выбран" }}</dd>
              </div>
              <div>
                <dt class="text-muted-foreground">Статус</dt>
                <dd class="mt-1">
                  {{ driver.isOnline ? "На линии" : "Не в сети" }} ·
                  {{ driver.isAvailable ? "Свободен" : "Занят" }}
                </dd>
              </div>
              <div>
                <dt class="text-muted-foreground">Последний вход</dt>
                <dd class="mt-1">{{ date(driver.user.lastLoginAt) }}</dd>
              </div>
              <div>
                <dt class="text-muted-foreground">GPS</dt>
                <dd class="mt-1">
                  {{
                    driver.lastLat != null && driver.lastLng != null
                      ? gpsAddress ||
                        `${Number(driver.lastLat).toFixed(5)}, ${Number(driver.lastLng).toFixed(5)}`
                      : "Нет координат"
                  }}
                </dd>
              </div>
              <div>
                <dt class="text-muted-foreground">Последняя геопозиция</dt>
                <dd class="mt-1">{{ date(driver.lastLocationAt) }}</dd>
              </div>
            </dl>
            <p
              v-if="driver.blockedReason"
              class="mt-4 text-sm text-destructive"
            >
              {{ driver.blockedReason }}
            </p>
            <div class="mt-5 flex flex-wrap gap-2">
              <Button
                v-if="driver.status === 'PENDING'"
                :disabled="pending"
                @click="act('approve')"
                >Одобрить</Button
              ><Button
                v-if="driver.status === 'BLOCKED'"
                :disabled="pending"
                @click="act('unblock')"
                >Разблокировать</Button
              ><Button
                v-else
                variant="outline"
                :disabled="pending"
                @click="
                  confirm = 'block';
                  reason = '';
                "
                >Заблокировать</Button
              >
            </div>
          </div>
          <details
            :open="Boolean(driver.pendingDeviceId)"
            class="group border-b pb-5"
          >
            <summary
              class="flex min-h-11 cursor-pointer items-center justify-between gap-3 font-semibold"
            >
              Устройства и входы
              <span class="text-sm font-normal text-muted-foreground">{{
                driver.pendingDeviceId ? "Ожидает подтверждения" : "Подробнее"
              }}</span>
            </summary>
            <p class="mt-2 text-sm text-muted-foreground">
              {{
                driver.isOnline && driver.shiftDeviceId
                  ? `На смене: ${driver.devices?.find((device) => device.deviceId === driver?.shiftDeviceId)?.label || "Устройство водителя"}`
                  : "Смена не запущена"
              }}
            </p>
            <p class="mt-2 text-sm text-muted-foreground">
              Одобренные устройства могут оставаться в аккаунте. Смена работает
              только на одном; разрешение входа не переносит смену.
            </p>
            <div
              v-if="driver.pendingDeviceId"
              class="mt-4 rounded-lg border bg-muted p-4"
            >
              <p class="text-sm font-medium">
                Запрос входа:
                {{ driver.pendingDeviceLabel || "Новое устройство" }}
              </p>
              <div class="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  :disabled="pending"
                  @click="act('approve-device')"
                  >Разрешить вход</Button
                ><Button
                  size="sm"
                  variant="outline"
                  :disabled="pending"
                  @click="act('reject-device')"
                  >Отклонить</Button
                >
              </div>
            </div>
            <div
              v-for="device in driver.devices"
              :key="device.id"
              class="mt-3 flex justify-between gap-3 border-t pt-3 text-xs"
            >
              <span
                >{{ device.label || "Устройство" }}
                {{
                  driver.isOnline && device.deviceId === driver.shiftDeviceId
                    ? "· на смене"
                    : ""
                }}</span
              ><span class="text-muted-foreground">{{
                date(device.lastLoginAt)
              }}</span>
            </div>
          </details>
        </div>
        <div class="space-y-6">
          <form
            class="grid gap-4 sm:grid-cols-2"
            @submit.prevent="act('vehicle', vehicle)"
          >
            <h2 class="font-semibold sm:col-span-2">Автомобиль</h2>
            <div
              v-for="field in [
                { key: 'plateNumber' as const, label: 'Госномер' },
                { key: 'make' as const, label: 'Марка' },
                { key: 'model' as const, label: 'Модель' },
                { key: 'color' as const, label: 'Цвет' },
              ]"
              :key="field.key"
              class="space-y-2"
            >
              <Label :for="field.key">{{ field.label }}</Label
              ><Input
                :id="field.key"
                v-model="vehicle[field.key]"
                :required="field.key === 'plateNumber'"
                :minlength="field.key === 'plateNumber' ? 2 : undefined"
                :maxlength="
                  field.key === 'plateNumber'
                    ? 20
                    : field.key === 'color'
                      ? 30
                      : 50
                "
              />
            </div>
            <Button
              type="submit"
              class="justify-self-start sm:col-span-2"
              :disabled="pending"
              >Сохранить автомобиль</Button
            >
          </form>
          <div class="border-t border-destructive/30 pt-5">
            <h2 class="font-semibold text-destructive">Деактивация аккаунта</h2>
            <p class="mt-2 text-sm text-muted-foreground">
              Водитель потеряет доступ. Баланс, история операций, переписка и
              привязка к заказам сохранятся.
            </p>
            <Button
              class="mt-4"
              variant="destructive"
              :disabled="pending"
              @click="confirm = 'delete'"
              >Деактивировать водителя</Button
            >
          </div>
        </div>
      </section>
      <section v-if="tab === 'balance'" class="space-y-6">
        <div class="rounded-xl border bg-card p-5">
          <p class="text-sm text-muted-foreground">Баланс</p>
          <p class="mt-2 text-3xl font-semibold tabular-nums">
            {{ money(driver.user.balance?.amount) }}
          </p>
          <p class="mt-2 text-xs text-muted-foreground">
            Пополнение и корректировка через диспетчера.
          </p>
          <form
            class="mt-5 grid gap-3 sm:grid-cols-2"
            @submit.prevent="adjust(false)"
          >
            <div class="space-y-2">
              <Label for="balance-amount">Сумма, TMT</Label
              ><Input
                id="balance-amount"
                v-model="amount"
                type="number"
                min="0.01"
                step="0.01"
                required
              />
            </div>
            <div class="space-y-2">
              <Label for="balance-note">Примечание</Label
              ><Input id="balance-note" v-model="note" maxlength="500" />
            </div>
            <div class="flex gap-2 sm:col-span-2">
              <Button
                type="submit"
                :disabled="pending || Number(amount) <= 0 || !amount"
                >Пополнить</Button
              ><Button
                variant="outline"
                :disabled="pending || Number(amount) <= 0 || !amount"
                @click="adjust(true)"
                >Списать</Button
              >
            </div>
          </form>
        </div>
        <h2 class="font-semibold">История баланса</h2>
        <div
          v-for="tx in history?.transactions.items"
          :key="tx.id"
          class="flex justify-between gap-4 rounded-lg border p-4 text-sm"
        >
          <div>
            <p>{{ transactionLabel(tx.type) }}</p>
            <p class="mt-1 text-xs text-muted-foreground">
              {{ date(tx.createdAt) }} · {{ tx.note }}
            </p>
          </div>
          <strong>{{ money(tx.amount) }}</strong>
        </div>
      </section>
      <section v-if="tab === 'history'" class="grid gap-4 xl:grid-cols-2">
        <OrderCard
          v-for="order in history?.orders.items"
          :key="order.id"
          :order="order"
        />
        <p
          v-if="!history?.orders.items.length"
          class="py-8 text-muted-foreground"
        >
          Поездок пока нет.
        </p>
      </section>
      <div
        v-if="
          tab !== 'info' &&
          Math.max(
            history?.orders.total ?? 0,
            history?.transactions.total ?? 0,
          ) > 20
        "
        class="flex gap-3"
      >
        <Button
          variant="outline"
          :disabled="historyPage === 1"
          @click="historyPage--"
          >Назад</Button
        ><span class="self-center text-sm">{{ historyPage }}</span
        ><Button
          variant="outline"
          :disabled="
            historyPage * 20 >=
            Math.max(
              history?.orders.total ?? 0,
              history?.transactions.total ?? 0,
            )
          "
          @click="historyPage++"
          >Далее</Button
        >
      </div></template
    ><Dialog
      :open="!!confirm"
      @update:open="!$event && !pending && (confirm = '')"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>{{
            confirm === "delete"
              ? "Деактивировать аккаунт?"
              : "Заблокировать водителя?"
          }}</DialogTitle
          ><DialogDescription>{{
            confirm === "delete"
              ? "Вход и рабочие сессии будут отключены. История и баланс сохранятся."
              : "Водитель потеряет доступ к рабочим операциям."
          }}</DialogDescription></DialogHeader
        ><template v-if="confirm === 'block'"
          ><Label for="block-reason">Причина, необязательно</Label
          ><Input id="block-reason" v-model="reason" maxlength="500"
        /></template>
        <p v-if="actionError" role="alert" class="text-sm text-destructive">
          {{ actionError }}
        </p>
        <DialogFooter
          ><Button variant="outline" :disabled="pending" @click="confirm = ''"
            >Отмена</Button
          ><Button
            variant="destructive"
            :disabled="pending"
            @click="act(confirm, { reason })"
            >{{ pending ? "Сохраняем…" : "Подтвердить" }}</Button
          ></DialogFooter
        ></DialogContent
      ></Dialog
    >
    <Dialog
      :open="!!credentialDialog"
      @update:open="!$event && closeCredentials()"
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{
            credentialDialog === "profile"
              ? "Данные водителя"
              : "Сбросить пароль"
          }}</DialogTitle>
          <DialogDescription
            >Смена телефона или пароля завершит все входы водителя и снимет его
            с линии. Баланс, одобренное устройство и текущая поездка сохранятся.
            Изменение только имени не завершает вход.</DialogDescription
          >
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="saveCredentials">
          <template v-if="credentialDialog === 'profile'">
            <div class="space-y-2">
              <Label for="driver-name">Имя водителя</Label
              ><Input
                id="driver-name"
                v-model="identity.fullName"
                required
                minlength="2"
                maxlength="120"
                autocomplete="name"
                :disabled="credentialPending"
              />
            </div>
            <div class="space-y-2">
              <Label for="driver-phone">Номер телефона</Label
              ><PhoneInput
                id="driver-phone"
                v-model="identity.phone"
                required
                :disabled="credentialPending"
              />
            </div>
          </template>
          <template v-else>
            <p class="text-xs text-muted-foreground">{{ passwordHint }}</p>
            <div class="space-y-2">
              <Label for="driver-password">Новый пароль</Label
              ><Input
                id="driver-password"
                v-model="newPassword"
                type="password"
                autocomplete="new-password"
                required
                minlength="6"
                maxlength="72"
                :disabled="credentialPending"
              />
            </div>
            <div class="space-y-2">
              <Label for="driver-password-confirmation">Повторите пароль</Label
              ><Input
                id="driver-password-confirmation"
                v-model="passwordConfirmation"
                type="password"
                autocomplete="new-password"
                required
                minlength="6"
                maxlength="72"
                :disabled="credentialPending"
              />
            </div>
          </template>
          <p
            v-if="credentialError"
            role="alert"
            class="text-sm text-destructive"
          >
            {{ credentialError }}
          </p>
          <DialogFooter
            ><Button type="button" variant="outline" @click="closeCredentials"
              >Отмена</Button
            ><Button type="submit" :disabled="credentialPending">{{
              credentialPending
                ? "Сохраняем…"
                : credentialDialog === "profile"
                  ? "Сохранить данные"
                  : "Изменить пароль"
            }}</Button></DialogFooter
          >
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
