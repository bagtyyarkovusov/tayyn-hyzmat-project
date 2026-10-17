<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useDocumentVisibility, useOnline } from "@vueuse/core";
import { useRoute, useRouter } from "vue-router";
import {
  LayoutDashboard,
  ClipboardList,
  Users,
  Map,
  MapPinned,
  ChartNoAxesCombined,
  MessageSquare,
  LogOut,
  UserRound,
  Navigation,
  Menu,
  Sun,
  Moon,
  Monitor,
} from "lucide-vue-next";
import BrandLogo from "@/shared/BrandLogo.vue";
import { Button } from "@/shared/ui/button";
import { adminSession, driverSession } from "@/features/auth/session";
import {
  themePreference,
  setTheme,
  type ThemePreference,
} from "@/shared/theme";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/shared/ui/dropdown-menu";
import { driverState } from "@/features/driver/useDriver";
import { useDriverNotifications } from "@/features/driver/notifications";
import AdminMessageAlert from "@/features/dispatcher/AdminMessageAlert.vue";
const route = useRoute();
const development = import.meta.env.DEV;
const visibility = useDocumentVisibility();
const networkOnline = useOnline();
const chat = computed(
  () => route.path === "/driverChat" || route.path.startsWith("/adminChat"),
);
useDriverNotifications(
  computed(
    () => route.path === "/driverChat" && visibility.value === "visible",
  ),
);
const viewportHeight = ref<string>();
const viewportTop = ref("0px");
function resizeChat() {
  viewportHeight.value = window.visualViewport
    ? `${window.visualViewport.height}px`
    : undefined;
  viewportTop.value = `${window.visualViewport?.offsetTop ?? 0}px`;
  document.documentElement.style.setProperty(
    "--app-viewport-height",
    viewportHeight.value ?? "100dvh",
  );
  document.documentElement.style.setProperty(
    "--app-viewport-top",
    viewportTop.value,
  );
}
onMounted(() => {
  resizeChat();
  window.visualViewport?.addEventListener("resize", resizeChat);
  window.visualViewport?.addEventListener("scroll", resizeChat);
});
onUnmounted(() => {
  window.visualViewport?.removeEventListener("resize", resizeChat);
  window.visualViewport?.removeEventListener("scroll", resizeChat);
});
const router = useRouter();
const auth = computed(() => route.meta.layout === "auth");
const driver = computed(() => route.path.startsWith("/driver"));
// Include portalled dialogs and login screens while leaving dispatcher text selectable.
watch(
  driver,
  (active) => document.documentElement.classList.toggle("driver-app", active),
  { immediate: true },
);
onUnmounted(() => document.documentElement.classList.remove("driver-app"));
const session = computed(() => (driver.value ? driverSession : adminSession));
const adminNav = [
  { to: "/adminDashboard", label: "Обзор", icon: LayoutDashboard },
  { to: "/adminOrders", label: "Заказы", icon: ClipboardList },
  { to: "/adminDrivers", label: "Водители", icon: Users },
  { to: "/adminDistricts", label: "Регионы", icon: Map },
  { to: "/adminMonitoring", label: "На карте", icon: MapPinned },
  { to: "/adminReports", label: "Активность", icon: ChartNoAxesCombined },
  { to: "/adminChat", label: "Сообщения", icon: MessageSquare },
];
const driverNav = [
  { to: "/driverDashboard", label: "Заказы", icon: Navigation },
  { to: "/driverMap", label: "Карта", icon: Map },
  { to: "/driverChat", label: "Чат", icon: MessageSquare },
  { to: "/driverProfile", label: "Профиль", icon: UserRound },
];
const nav = computed(() => (driver.value ? driverNav : adminNav));
watch(
  () => session.value.state.accessToken,
  (token) => {
    if (!token && !auth.value)
      router.replace(driver.value ? "/driverLogin" : "/adminLogin");
  },
);
watch([networkOnline, visibility], ([online, visible]) => {
  if (online && visible === "visible" && session.value.state.verificationError)
    void session.value.restore();
});
async function logout() {
  await session.value.logout();
  await router.replace(driver.value ? "/driverLogin" : "/adminLogin");
}
</script>
<template>
  <RouterView v-if="auth" />
  <main
    v-else-if="session.state.restoring || session.state.verificationError"
    class="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center"
    aria-live="polite"
  >
    <BrandLogo />
    <p>
      {{
        session.state.restoring
          ? "Проверяем подключение…"
          : session.state.verificationError
      }}
    </p>
    <Button v-if="!session.state.restoring" @click="session.restore()"
      >Повторить подключение</Button
    >
  </main>
  <div
    v-else
    :style="chat ? { height: viewportHeight, top: viewportTop } : undefined"
    :class="[
      'workspace',
      {
        'driver-workspace': driver,
        'chat-workspace': chat,
        'driver-home-workspace': route.path === '/driverDashboard',
      },
    ]"
  >
    <AdminMessageAlert v-if="!driver" />
    <aside v-if="!driver" class="sidebar">
      <RouterLink to="/adminDashboard" class="brand"><BrandLogo /></RouterLink>
      <p class="mt-7 mb-3 text-xs text-muted-foreground">
        Рабочее пространство
      </p>
      <nav aria-label="Разделы диспетчера" class="grid gap-1">
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="nav-link"
          :class="{
            selected:
              route.path === item.to ||
              (item.to !== '/adminDashboard' &&
                route.path.startsWith(item.to + '/')),
          }"
          ><component :is="item.icon" class="size-[18px]" />{{
            item.label
          }}</RouterLink
        >
      </nav>
      <div
        v-if="development"
        class="mt-auto border-t pt-5 text-xs text-muted-foreground"
      >
        <p>Тестовая среда</p>
        <p class="mt-1">Синтетические балансы · TMT</p>
        <a
          href="/legacy/"
          class="mt-3 inline-block underline underline-offset-4"
          >Совместимость: прежнее приложение</a
        >
      </div>
    </aside>
    <div class="min-w-0 flex-1">
      <header class="workspace-header">
        <div class="flex min-w-0 items-center gap-3">
          <BrandLogo compact /><span class="connection"
            ><i
              :class="{
                online: driver
                  ? driverState.profile?.isOnline &&
                    driverState.profile?.canControlShift !== false
                  : session.state.connected,
                'connection-pulse':
                  visibility === 'visible' &&
                  networkOnline &&
                  session.state.connected &&
                  (!driver ||
                    (driverState.profile?.isOnline &&
                      driverState.profile?.canControlShift !== false &&
                      driverState.gpsReady)),
              }"
            />{{
              driver
                ? driverState.profile?.canControlShift === false
                  ? "Смена на другом устройстве"
                  : driverState.profile?.isOnline
                    ? "На линии"
                    : "Не на линии"
                : session.state.connected
                  ? "На связи"
                  : "Подключение…"
            }}</span
          >
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger as-child
              ><Button
                variant="ghost"
                size="icon"
                class="size-11"
                aria-label="Тема"
                ><component
                  :is="
                    themePreference === 'system'
                      ? Monitor
                      : themePreference === 'dark'
                        ? Moon
                        : Sun
                  "
                  class="size-5" /></Button
            ></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                :model-value="themePreference"
                @update:model-value="setTheme($event as ThemePreference)"
              >
                <DropdownMenuRadioItem value="system"
                  ><Monitor
                    class="mr-2 size-4"
                  />Системная</DropdownMenuRadioItem
                >
                <DropdownMenuRadioItem value="light"
                  ><Sun class="mr-2 size-4" />Светлая</DropdownMenuRadioItem
                >
                <DropdownMenuRadioItem value="dark"
                  ><Moon class="mr-2 size-4" />Тёмная</DropdownMenuRadioItem
                >
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            class="size-11"
            aria-label="Выйти"
            @click="logout"
            ><LogOut class="size-4"
          /></Button>
        </div>
      </header>
      <p
        v-if="driver && !networkOnline"
        role="status"
        class="border-b bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
      >
        Нет интернета. Пытаемся подключиться…
      </p>
      <p
        v-else-if="driver && !session.state.connected"
        role="status"
        class="border-b bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
      >
        Связь с диспетчером прервана. Переподключаемся…
      </p>
      <nav
        v-if="!driver"
        class="mobile-admin-nav"
        aria-label="Разделы диспетчера"
      >
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          :class="{ selected: route.path === item.to }"
          >{{ item.label }}</RouterLink
        >
      </nav>
      <main
        id="main"
        :class="['route-content', driver ? 'driver-content' : 'admin-content']"
      >
        <RouterView />
      </main>
    </div>
    <nav v-if="driver" class="driver-nav" aria-label="Разделы водителя">
      <RouterLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        :class="{ selected: route.path === item.to }"
        ><component :is="item.icon" class="size-5" /><span>{{
          item.label
        }}</span></RouterLink
      >
    </nav>
  </div>
</template>
<style>
.brand {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: -0.03em;
}
.workspace {
  min-height: 100svh;
  display: flex;
}
.sidebar {
  width: 235px;
  padding: 1.75rem 1.25rem;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  position: fixed;
  inset: 0 auto 0 0;
  background: var(--card);
}
.workspace:not(.driver-workspace) > div {
  margin-left: 235px;
}
.nav-link {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 0.85rem;
  border-radius: 0.5rem;
  color: var(--muted-foreground);
  font-weight: 500;
}
.nav-link:hover,
.nav-link.selected {
  color: var(--primary);
  background: var(--secondary);
}
.workspace-header {
  height: 76px;
  border-bottom: 1px solid var(--border);
  padding: 0 2rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  background: var(--card);
}
.connection {
  font-size: 0.75rem;
  color: var(--muted-foreground);
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.connection i {
  position: relative;
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted-foreground);
}
.driver-workspace .connection i {
  background: var(--destructive);
}
.connection .online,
.driver-workspace .connection .online {
  background: var(--success);
}
.connection-pulse::after {
  content: "";
  position: absolute;
  inset: -3px;
  border: 1px solid var(--success);
  border-radius: inherit;
  pointer-events: none;
  animation: connection-ripple 2.8s ease-out infinite;
}
@keyframes connection-ripple {
  0% {
    opacity: 0.65;
    transform: scale(1);
  }
  60%,
  100% {
    opacity: 0;
    transform: scale(1.9);
  }
}
@media (prefers-reduced-motion: reduce) {
  .connection-pulse::after {
    display: none;
  }
}
.admin-content {
  max-width: 1600px;
  margin: auto;
  padding: 2rem;
}
.driver-content {
  max-width: 760px;
  margin: auto;
  padding: 1.5rem 1.25rem 7rem;
}
.driver-workspace .workspace-header {
  max-width: 960px;
  margin: auto;
  background: var(--card);
}
.driver-nav {
  position: fixed;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: min(100%, 760px);
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border: 1px solid var(--border);
  border-bottom: 0;
  background: var(--card);
  border-radius: 1rem 1rem 0 0;
  padding: 0.65rem 0.5rem max(0.65rem, env(safe-area-inset-bottom));
  z-index: 30;
}
.driver-nav a {
  display: grid;
  justify-items: center;
  gap: 0.2rem;
  padding: 0.35rem;
  font-size: 0.7rem;
  color: var(--muted-foreground);
}
.driver-nav .selected {
  color: var(--primary);
  font-weight: 700;
}
.mobile-admin-nav {
  display: none;
}
@media (max-width: 1000px) {
  .sidebar {
    width: 220px;
  }
  .workspace:not(.driver-workspace) > div {
    margin-left: 220px;
  }
  .admin-content {
    padding: 1.5rem;
  }
  .workspace-header {
    padding: 0 1.5rem;
  }
}
/* The sidebar owns dispatcher branding whenever it is visible. */
@media (min-width: 761px) {
  .workspace:not(.driver-workspace) .workspace-header .brand-lockup {
    display: none;
  }
}
@media (max-width: 760px) {
  .sidebar {
    display: none;
  }
  .workspace:not(.driver-workspace) > div {
    margin-left: 0;
  }
  .workspace-header {
    height: 64px;
    padding: 0 1rem;
  }
  .connection {
    font-size: 0;
  }
  .connection i {
    width: 7px;
    height: 7px;
  }
  .mobile-admin-nav {
    display: flex;
    overflow: auto;
    gap: 0.25rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  .mobile-admin-nav a {
    white-space: nowrap;
    padding: 0.35rem 0.65rem;
    border-radius: 0.4rem;
    color: var(--muted-foreground);
    font-size: 0.8rem;
  }
  .mobile-admin-nav .selected {
    background: var(--secondary);
    color: var(--primary);
  }
  .admin-content {
    padding: 1.25rem 1rem;
  }
  .driver-content {
    padding: 1.25rem 1rem 7rem;
  }
}
/* Keep the regional overview between the app header and bottom navigation. */
.driver-home-workspace {
  height: 100dvh;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}
.driver-home-workspace > div {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.driver-home-workspace .workspace-header {
  width: 100%;
  flex-shrink: 0;
}
.driver-home-workspace .driver-content {
  width: 100%;
  flex: 1;
  min-height: 0;
  margin: 0 auto;
  padding: 0.5rem 0.75rem;
}
.driver-home-workspace .driver-nav {
  position: static;
  transform: none;
  flex-shrink: 0;
  margin: 0 auto;
}
@media (orientation: landscape) and (max-height: 500px) {
  .driver-home-workspace .workspace-header {
    height: 48px;
  }
  .driver-home-workspace .driver-nav {
    padding-top: 0.25rem;
    padding-bottom: max(0.25rem, env(safe-area-inset-bottom));
  }
  .driver-home-workspace .driver-nav a {
    padding-block: 0.15rem;
    gap: 0;
  }
}
/* Chat keeps the composer and navigation in the visible viewport, including a resized keyboard viewport. */
.chat-workspace {
  position: fixed;
  inset: 0;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}
.chat-workspace.driver-workspace {
  flex-direction: column;
}
.chat-workspace > div {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.chat-workspace .workspace-header {
  flex-shrink: 0;
  height: 56px;
  width: 100%;
}
.chat-workspace .mobile-admin-nav {
  flex-shrink: 0;
  padding-block: 0.25rem;
}
.chat-workspace .route-content {
  flex: 1;
  width: 100%;
  min-height: 0;
  margin: 0 auto;
  padding: 0.5rem 0.75rem;
  overflow: hidden;
}
.chat-workspace .driver-nav {
  position: static;
  transform: none;
  flex-shrink: 0;
  margin: 0 auto;
  padding-top: 0.25rem;
}
.chat-workspace .driver-nav a {
  padding-block: 0.2rem;
}
</style>
