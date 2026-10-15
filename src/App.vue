<script setup lang="ts">
import { computed, watch } from "vue";
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
  Truck,
  UserRound,
  Navigation,
  Menu,
} from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { adminSession, driverSession } from "@/features/auth/session";
import {
  themePreference,
  setTheme,
  type ThemePreference,
} from "@/shared/theme";
const route = useRoute();
const router = useRouter();
const auth = computed(() =>
  ["/adminLogin", "/driverLogin", "/driverRegister"].includes(route.path),
);
const driver = computed(() => route.path.startsWith("/driver"));
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
async function logout() {
  await session.value.logout();
  await router.replace(driver.value ? "/driverLogin" : "/adminLogin");
}
</script>
<template>
  <RouterView v-if="auth" />
  <div v-else :class="['workspace', { 'driver-workspace': driver }]">
    <aside v-if="!driver" class="sidebar">
      <RouterLink to="/adminDashboard" class="brand"
        ><span class="brand-symbol">т</span
        ><span>тайын хызмат</span></RouterLink
      >
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
      <div class="mt-auto border-t pt-5 text-xs text-muted-foreground">
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
          <Truck v-if="driver" class="size-5 text-primary" /><span
            class="font-semibold"
            >{{ driver ? "Тайын Хызмат" : "Диспетчерская" }}</span
          ><span class="connection"
            ><i :class="{ online: session.state.connected }" />{{
              session.state.connected ? "На связи" : "Подключение…"
            }}</span
          >
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <label class="sr-only" for="theme">Тема</label
          ><select
            id="theme"
            aria-label="Тема"
            class="theme-select"
            :value="themePreference"
            @change="
              setTheme(
                ($event.target as HTMLSelectElement).value as ThemePreference,
              )
            "
          >
            <option value="system">Системная</option>
            <option value="light">Светлая</option>
            <option value="dark">Тёмная</option></select
          ><Button
            variant="ghost"
            size="icon"
            aria-label="Выйти"
            @click="logout"
            ><LogOut class="size-4"
          /></Button>
        </div>
      </header>
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
.brand-symbol {
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  border: 1px solid currentColor;
  border-radius: 0.6rem;
  font-size: 1.7rem;
  font-weight: 500;
  line-height: 1;
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
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted-foreground);
}
.connection .online {
  background: var(--primary);
}
.theme-select {
  background-color: transparent;
  font-size: 0.75rem;
  max-width: 7rem;
  padding: 0.5rem 2rem 0.5rem 0.5rem;
  border-radius: 0.4rem;
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
  background: transparent;
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
    width: 200px;
  }
  .workspace:not(.driver-workspace) > div {
    margin-left: 200px;
  }
  .admin-content {
    padding: 1.5rem;
  }
  .workspace-header {
    padding: 0 1.5rem;
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
</style>
