<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { ArrowLeft } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import ChatComposer from "@/shared/ChatComposer.vue";
import { useChatScroll } from "@/shared/useChatScroll";
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
import { adminSession } from "@/features/auth/session";
import { date, type Driver, type Page, type Message } from "./domain";
import { useResource } from "./useResource";
import PageState from "./components/PageState.vue";
const props = defineProps<{ driverId?: string }>();
const { history, track, updated } = useChatScroll();
let alive = true;
onUnmounted(() => {
  alive = false;
});
const body = ref(""),
  pending = ref(false),
  sendError = ref(""),
  broadcast = ref(false),
  broadcastBody = ref(""),
  sent = ref(false),
  unread = ref<string[]>([]);
const {
  data: drivers,
  loading,
  error,
  load,
} = useResource(
  async () => {
    const [list, badges] = await Promise.all([
      adminApi.get<Page<Driver>>("/admin/drivers", {
        params: { status: "APPROVED", limit: 100 },
      }),
      adminApi.get<{ driverIds: string[] }>("/admin/messages/unread"),
    ]);
    unread.value = badges.data.driverIds;
    return list.data.items;
  },
  [],
  ["driver:message"],
);
const {
  data: thread,
  loading: threadLoading,
  error: threadError,
  load: loadThread,
} = useResource(
  async () => {
    const driverId = props.driverId;
    if (!driverId) return null;
    const [messages, driver] = await Promise.all([
      adminApi.get<Page<Message>>(`/admin/drivers/${driverId}/messages`, {
        params: { limit: 100 },
      }),
      adminApi.get<Driver>(`/admin/drivers/${driverId}`),
    ]);
    try {
      if (props.driverId !== driverId)
        return {
          messages: messages.data.items,
          total: messages.data.total,
          driver: driver.data,
        };
      await adminApi.post(`/admin/drivers/${driverId}/messages/read`);
      unread.value = unread.value.filter((id) => id !== driverId);
    } catch {
      /* Keep unread state if marking read fails. */
    }
    return {
      messages: messages.data.items,
      total: messages.data.total,
      driver: driver.data,
    };
  },
  null as { messages: Message[]; total: number; driver: Driver } | null,
  ["driver:message", "admin:message"],
);
watch(
  () => props.driverId,
  () => {
    body.value = "";
    sendError.value = "";
    void loadThread();
    void updated(true);
  },
);
watch(thread, () => void updated());
async function send(all = false) {
  const text = (all ? broadcastBody.value : body.value).trim();
  if (!text || pending.value) return;
  const targetDriver = props.driverId;
  pending.value = true;
  sendError.value = "";
  sent.value = false;
  try {
    await adminApi.post(
      "/admin/messages",
      all
        ? { broadcast: true, body: text }
        : { driverId: targetDriver, body: text },
    );
    if (!alive || (!all && targetDriver !== props.driverId)) return;
    if (all) {
      broadcastBody.value = "";
      broadcast.value = false;
      sent.value = true;
    } else {
      body.value = "";
      await loadThread();
      await updated(true);
    }
  } catch (e) {
    if (alive && (all || targetDriver === props.driverId))
      sendError.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <div class="flex h-full min-h-0 flex-col gap-2">
    <header class="flex shrink-0 items-center justify-between gap-2">
      <div>
        <h1 class="text-lg font-semibold">Сообщения</h1>
      </div>
      <Button
        variant="outline"
        @click="
          broadcast = true;
          sendError = '';
        "
        >Сообщение всем</Button
      >
    </header>
    <p v-if="sent" role="status" class="text-sm text-primary">
      Сообщение отправлено всем водителям.
    </p>
    <div class="grid min-h-0 flex-1 gap-3 lg:grid-cols-[300px_1fr]">
      <aside
        class="min-h-0 overflow-y-auto overscroll-contain"
        :class="driverId ? 'hidden lg:block' : ''"
      >
        <PageState
          :loading="loading"
          :error="error"
          :empty="!drivers.length"
          @retry="load"
        />
        <div class="overflow-hidden rounded-xl border bg-card">
          <RouterLink
            v-for="driver in drivers"
            :key="driver.id"
            :to="`/adminChat/${driver.id}`"
            class="flex items-center justify-between gap-3 border-b p-4 last:border-0 hover:bg-muted"
            :class="driverId === driver.id ? 'bg-primary/10' : ''"
            ><div class="min-w-0">
              <p class="truncate text-sm font-medium">
                {{ driver.user.fullName }}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">
                {{ driver.user.phone }}
              </p>
            </div>
            <span
              v-if="unread.includes(driver.id)"
              aria-label="Непрочитанные сообщения"
              class="size-2 shrink-0 rounded-full bg-primary"
          /></RouterLink>
        </div>
      </aside>
      <section
        v-if="driverId"
        class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card"
      >
        <div class="flex shrink-0 items-center gap-3 border-b p-3">
          <RouterLink to="/adminChat" aria-label="Все диалоги" class="lg:hidden"
            ><ArrowLeft class="size-4"
          /></RouterLink>
          <div>
            <h2 class="font-semibold">
              {{ thread?.driver.user.fullName || "Диалог" }}
            </h2>
            <p class="text-xs text-muted-foreground">
              {{ thread?.driver.isOnline ? "На линии" : "Не в сети" }}
            </p>
          </div>
          <Button
            v-if="thread"
            variant="ghost"
            size="sm"
            class="ml-auto"
            as-child
            ><RouterLink :to="`/adminDrivers/${driverId}`"
              >Профиль</RouterLink
            ></Button
          >
        </div>
        <div
          ref="history"
          aria-label="Переписка"
          class="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3"
          @scroll="track"
        >
          <PageState
            :loading="threadLoading"
            :error="threadError"
            @retry="loadThread"
          />
          <p
            v-if="thread && !thread.messages.length"
            class="py-10 text-center text-sm text-muted-foreground"
          >
            Начните разговор с водителем.
          </p>
          <p
            v-if="thread && thread.total > 100"
            class="text-center text-xs text-muted-foreground"
          >
            Последние 100 сообщений
          </p>
          <div
            v-for="message in thread?.messages"
            :key="message.id"
            class="flex"
            :class="
              message.senderId === thread?.driver.userId
                ? 'justify-start'
                : 'justify-end'
            "
          >
            <div
              class="max-w-[85%] rounded-xl p-3"
              :class="
                message.senderId === thread?.driver.userId
                  ? 'bg-muted'
                  : 'bg-primary text-primary-foreground'
              "
            >
              <p class="whitespace-pre-wrap break-words text-sm">
                {{ message.body }}
              </p>
              <p class="mt-1 text-right text-[11px] opacity-70">
                {{ date(message.sentAt) }}
              </p>
            </div>
          </div>
        </div>
        <ChatComposer
          v-model="body"
          label="Сообщение водителю"
          :pending="pending"
          @send="send()"
        />
        <p
          v-if="sendError"
          role="alert"
          class="shrink-0 px-3 pb-2 text-sm text-destructive"
        >
          {{ sendError }}
        </p>
      </section>
      <section
        v-else
        class="hidden min-h-80 items-center justify-center rounded-xl border border-dashed lg:flex"
      >
        <p class="text-sm text-muted-foreground">
          Выберите водителя, чтобы открыть диалог.
        </p>
      </section>
    </div>
    <Dialog v-model:open="broadcast"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>Сообщение всем водителям</DialogTitle
          ><DialogDescription
            >Сообщение будет отправлено всей команде. Проверьте текст перед
            отправкой.</DialogDescription
          ></DialogHeader
        ><Label for="broadcast-body">Текст сообщения</Label
        ><Textarea
          id="broadcast-body"
          v-model="broadcastBody"
          maxlength="2000"
          rows="5"
        />
        <p v-if="sendError" role="alert" class="text-sm text-destructive">
          {{ sendError }}
        </p>
        <DialogFooter
          ><Button
            variant="outline"
            :disabled="pending"
            @click="broadcast = false"
            >Отмена</Button
          ><Button
            :disabled="pending || !broadcastBody.trim()"
            @click="send(true)"
            >{{ pending ? "Отправляем…" : "Отправить всем" }}</Button
          ></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </div>
</template>
