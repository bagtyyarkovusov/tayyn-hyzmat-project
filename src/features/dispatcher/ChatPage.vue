<script setup lang="ts">
import { formatPhone } from "@/shared/phone";
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { ArrowLeft } from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import ChatComposer from "@/shared/ChatComposer.vue";
import { useChatRecovery } from "@/shared/useChatRecovery";
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
const route = useRoute();
const allDrivers = computed(
  () => !props.driverId && route.query.broadcast === "1",
);
const { history, track, updated, followAfterSend } = useChatScroll();
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
  data: broadcasts,
  loading: broadcastsLoading,
  error: broadcastsError,
  load: loadBroadcasts,
} = useResource(
  async () =>
    (
      await adminApi.get<Page<Message>>("/admin/messages/broadcasts", {
        params: { limit: 30 },
      })
    ).data,
  { items: [], total: 0, page: 1, limit: 30 },
  ["admin:message"],
);
const olderBroadcastsLoading = ref(false);
async function loadOlderBroadcasts() {
  if (olderBroadcastsLoading.value) return;
  olderBroadcastsLoading.value = true;
  const previousHeight = history.value?.scrollHeight ?? 0;
  try {
    const { data } = await adminApi.get<Page<Message>>(
      "/admin/messages/broadcasts",
      { params: { beforeMessageId: broadcasts.value.items[0]?.id, limit: 30 } },
    );
    if (!alive) return;
    broadcasts.value = {
      ...data,
      items: [
        ...new Map(
          [...data.items, ...broadcasts.value.items].map((message) => [
            message.id,
            message,
          ]),
        ).values(),
      ],
    };
    await nextTick();
    if (history.value)
      history.value.scrollTop += history.value.scrollHeight - previousHeight;
  } catch (error) {
    if (alive) sendError.value = errorMessage(error);
  } finally {
    olderBroadcastsLoading.value = false;
  }
}
watch(allDrivers, () => {
  sendError.value = "";
  void loadBroadcasts();
  void updated(true);
});
const olderLoading = ref(false);
type Thread = { messages: Message[]; total: number; driver: Driver };
let retryMessage: { body: string; target: string; id: string } | undefined;
async function loadOlder() {
  if (
    !thread.value ||
    olderLoading.value ||
    thread.value.messages.length >= thread.value.total
  )
    return;
  olderLoading.value = true;
  const driverId = thread.value.driver.id;
  const previousHeight = history.value?.scrollHeight ?? 0;
  try {
    const { data } = await adminApi.get<Page<Message>>(
      `/admin/drivers/${driverId}/messages`,
      { params: { beforeMessageId: thread.value.messages[0]?.id, limit: 100 } },
    );
    if (!alive || props.driverId !== driverId || !thread.value) return;
    const merged = [...data.items, ...thread.value.messages];
    thread.value = {
      ...thread.value,
      messages: [
        ...new Map(merged.map((message) => [message.id, message])).values(),
      ],
      total: data.total,
    };
    await nextTick();
    if (history.value)
      history.value.scrollTop += history.value.scrollHeight - previousHeight;
  } catch (error) {
    if (alive && props.driverId === driverId)
      sendError.value = errorMessage(error);
  } finally {
    olderLoading.value = false;
  }
}
const {
  data: thread,
  loading: threadLoading,
  error: threadError,
  load: loadThread,
} = useResource<Thread | null>(
  async (): Promise<Thread | null> => {
    const driverId = props.driverId;
    if (!driverId) return null;
    const [messages, driver] = await Promise.all([
      adminApi.get<Page<Message>>(`/admin/drivers/${driverId}/messages`, {
        params: { limit: 100 },
      }),
      adminApi.get<Driver>(`/admin/drivers/${driverId}`),
    ]);
    const anchor =
      thread.value?.driver.id === driverId
        ? thread.value.messages.at(-1)?.id
        : undefined;
    let fetchedPage = 1;
    while (
      anchor &&
      !messages.data.items.some((message) => message.id === anchor) &&
      fetchedPage * 100 < messages.data.total
    ) {
      const more = await adminApi.get<Page<Message>>(
        `/admin/drivers/${driverId}/messages`,
        { params: { beforeMessageId: messages.data.items[0]?.id, limit: 100 } },
      );
      fetchedPage++;
      if (!alive || props.driverId !== driverId) return null;
      if (!more.data.items.length) break;
      messages.data.items.unshift(...more.data.items);
    }
    try {
      if (props.driverId !== driverId)
        return {
          messages: messages.data.items,
          total: messages.data.total,
          driver: driver.data,
        };
      if (!document.hidden) {
        const lastIncoming = [...messages.data.items]
          .reverse()
          .find((message) => message.senderId === driver.data.userId);
        if (lastIncoming)
          await adminApi.post(`/admin/drivers/${driverId}/messages/read`, {
            throughMessageId: lastIncoming.id,
          });
        unread.value = unread.value.filter((id) => id !== driverId);
      }
    } catch {
      /* Keep unread state if marking read fails. */
    }
    const existing =
      thread.value?.driver.id === driverId ? thread.value.messages : [];
    return {
      messages: [
        ...new Map(
          [...existing, ...messages.data.items].map((message) => [
            message.id,
            message,
          ]),
        ).values(),
      ].sort(
        (a, b) =>
          Date.parse(a.sentAt) - Date.parse(b.sentAt) ||
          a.id.localeCompare(b.id),
      ),
      total: messages.data.total,
      driver: driver.data,
    };
  },
  null as { messages: Message[]; total: number; driver: Driver } | null,
  ["driver:message", "admin:message"],
);
useChatRecovery(() => {
  void load();
  void loadThread();
  void loadBroadcasts();
});
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
  const finishScroll = followAfterSend();
  const targetDriver = props.driverId;
  const target = all ? "broadcast" : (targetDriver ?? "");
  if (retryMessage?.body !== text || retryMessage.target !== target)
    retryMessage = { body: text, target, id: crypto.randomUUID() };
  pending.value = true;
  sendError.value = "";
  sent.value = false;
  try {
    await adminApi.post(
      "/admin/messages",
      all
        ? { broadcast: true, body: text, clientMessageId: retryMessage.id }
        : {
            driverId: targetDriver,
            body: text,
            clientMessageId: retryMessage.id,
          },
    );
    if (!alive || (!all && targetDriver !== props.driverId)) return;
    retryMessage = undefined;
    if (all) {
      broadcastBody.value = "";
      broadcast.value = false;
      sent.value = true;
      await Promise.all([loadBroadcasts(), loadThread()]);
      await finishScroll();
    } else {
      body.value = "";
      await loadThread();
      await finishScroll();
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
        :class="driverId || allDrivers ? 'hidden lg:block' : ''"
      >
        <RouterLink
          to="/adminChat?broadcast=1"
          class="mb-3 flex min-h-12 items-center rounded-xl border p-4 font-semibold"
          :class="allDrivers ? 'bg-secondary' : ''"
          >Все водители</RouterLink
        >
        <PageState
          :loading="loading && !drivers.length"
          :error="error"
          :empty="!drivers.length"
          empty-title="Диалогов пока нет"
          empty-description="Добавленные водители появятся здесь."
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
                {{ formatPhone(driver.user.phone) }}
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
          <RouterLink
            to="/adminChat"
            aria-label="Все диалоги"
            class="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted lg:hidden"
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
          role="region"
          aria-label="Переписка"
          class="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3"
          @scroll="track"
        >
          <PageState
            :loading="threadLoading && !thread"
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
            v-if="thread && thread.total > thread.messages.length"
            class="text-center text-xs text-muted-foreground"
          >
            <Button
              variant="ghost"
              size="sm"
              :disabled="olderLoading"
              @click="loadOlder"
            >
              {{
                olderLoading ? "Загрузка…" : "Загрузить более ранние сообщения"
              }}
            </Button>
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
              <p v-if="message.isBroadcast" class="mb-1 text-xs font-semibold">
                Всем водителям
              </p>
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
        v-else-if="allDrivers"
        class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card"
      >
        <header class="flex shrink-0 items-center gap-3 border-b p-3">
          <RouterLink
            to="/adminChat"
            aria-label="Все диалоги"
            class="flex size-11 items-center justify-center lg:hidden"
            ><ArrowLeft class="size-4"
          /></RouterLink>
          <h2 class="font-semibold">Все водители</h2>
        </header>
        <div
          ref="history"
          role="region"
          aria-label="Отправленные всем водителям"
          class="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3"
          @scroll="track"
        >
          <PageState
            :loading="broadcastsLoading && !broadcasts.items.length"
            :error="broadcastsError"
            @retry="loadBroadcasts"
          />
          <p
            v-if="!broadcastsLoading && !broadcasts.items.length"
            class="py-10 text-center text-sm text-muted-foreground"
          >
            Сообщений пока нет.
          </p>
          <Button
            v-if="broadcasts.total > broadcasts.items.length"
            variant="ghost"
            :disabled="olderBroadcastsLoading"
            @click="loadOlderBroadcasts"
            >Загрузить более ранние сообщения</Button
          >
          <article
            v-for="message in broadcasts.items"
            :key="message.id"
            class="ml-auto w-fit max-w-[85%] rounded-xl bg-primary p-3 text-primary-foreground"
          >
            <p class="mb-1 text-xs font-semibold">Всем водителям</p>
            <p class="whitespace-pre-wrap break-words text-base">
              {{ message.body }}
            </p>
            <p class="mt-1 text-right text-xs opacity-80">
              {{ date(message.sentAt) }}
            </p>
          </article>
        </div>
        <div class="border-t p-3">
          <Button class="min-h-11 w-full" @click="broadcast = true"
            >Сообщение всем</Button
          >
        </div>
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
