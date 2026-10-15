import type { RouteRecordRaw } from "vue-router";
export const driverRoutes: RouteRecordRaw[] = [
  {
    path: "/driverDashboard",
    name: "driverDashboard",
    component: () => import("./DriverDashboard.vue"),
    meta: { role: "DRIVER", title: "На линии" },
  },
  {
    path: "/driverMap",
    name: "driverMap",
    component: () => import("./DriverMap.vue"),
    meta: { role: "DRIVER", title: "Карта" },
  },
  {
    path: "/driverProfile",
    name: "driverProfile",
    component: () => import("./DriverProfile.vue"),
    meta: { role: "DRIVER", title: "Профиль" },
  },
  {
    path: "/driverChat",
    name: "driverChat",
    component: () => import("./DriverChat.vue"),
    meta: { role: "DRIVER", title: "Диспетчер" },
  },
  {
    path: "/driverSupport",
    name: "driverSupport",
    redirect: "/driverChat",
    meta: { role: "DRIVER" },
  },
];
