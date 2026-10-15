import type { RouteRecordRaw } from "vue-router";
const secure = { requiresAdminAuth: true };
export const dispatcherRoutes: RouteRecordRaw[] = [
  { path: "/admin", redirect: "/adminDashboard" },
  {
    path: "/adminDashboard",
    component: () => import("./DashboardPage.vue"),
    meta: secure,
  },
  {
    path: "/adminOrders",
    component: () => import("./OrdersPage.vue"),
    meta: secure,
  },
  {
    path: "/adminDrivers",
    component: () => import("./DriversPage.vue"),
    meta: secure,
  },
  {
    path: "/adminDrivers/:driverId",
    component: () => import("./DriverDetailPage.vue"),
    props: true,
    meta: secure,
  },
  {
    path: "/adminDistricts",
    component: () => import("./RegionsPage.vue"),
    meta: secure,
  },
  {
    path: "/adminDistricts/boundaries",
    component: () => import("./BoundariesPage.vue"),
    meta: secure,
  },
  {
    path: "/adminMonitoring",
    component: () => import("./MonitoringPage.vue"),
    meta: secure,
  },
  {
    path: "/adminReports",
    component: () => import("./ReportsPage.vue"),
    meta: secure,
  },
  {
    path: "/adminChat",
    component: () => import("./ChatPage.vue"),
    meta: secure,
  },
  {
    path: "/adminChat/:driverId",
    component: () => import("./ChatPage.vue"),
    props: true,
    meta: secure,
  },
];
