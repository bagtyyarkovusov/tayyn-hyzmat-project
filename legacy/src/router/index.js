import Vue from 'vue'
import Router from 'vue-router'
import firebase from '@/services/firebase'
import store from '@/store'
import Home from '@/components/Home'
import Login from '@/components/Login'
import ClientLogin from '@/components/ClientLogin'
import ClientRegister from '@/components/ClientRegister'
import ClientDashboard from '@/components/ClientDashboard'
import ClientProfile from '@/components/ClientProfile'
import ClientPickupNew from '@/components/ClientPickupNew'
import ClientPickupEdit from '@/components/ClientPickupEdit'
import ClientSupport from '@/components/ClientSupport'
import DriverAuth from '@/driver/DriverAuth'
import DriverHome from '@/driver/DriverHome'
import DriverMap from '@/driver/DriverMap'
import DriverProfile from '@/driver/DriverProfile'
import DriverChat from '@/driver/DriverChat'
import DriverSupport from '@/components/DriverSupport'
import TripFuture from '@/components/TripFuture'
import TripHistory from '@/components/TripHistory'
import TripNext from '@/components/TripNext'
import MapPickupNew from '@/components/MapPickupNew'
import AdminAuth from '@/admin/AdminAuth'
import AdminDashboard from '@/admin/AdminDashboard'
import AdminDrivers from '@/admin/AdminDrivers'
import AdminDriverDetail from '@/admin/AdminDriverDetail'
import AdminOrders from '@/admin/AdminOrders'
import AdminDistricts from '@/admin/AdminDistricts'
import AdminDistrictBoundaries from '@/admin/AdminDistrictBoundaries'
import AdminMap from '@/admin/AdminMap'
import AdminReports from '@/admin/AdminReports'
import AdminChatList from '@/admin/AdminChatList'
import AdminChatPage from '@/admin/AdminChatPage'

Vue.use(Router)

const routes = [
  {
    path: '/',
    name: 'Home',
    component: Home
  },
  { path: '/map', component: MapPickupNew },
  { path: '/login', component: Login, props: true },
  { path: '/clientLogin', component: ClientLogin, props: true },
  { path: '/clientRegister', component: ClientRegister, props: true },
  { path: '/clientDashboard', component: ClientDashboard, meta: {
    requiresAuth: false
  } },
  { path: '/clientProfile', component: ClientProfile, meta: {
    requiresAuth: false
  } },
  { path: '/newPickup', component: ClientPickupNew, meta: {
    requiresAuth: false
  } },
  { path: '/editPickup', component: ClientPickupEdit, meta: {
    requiresAuth: false
  } },
  { path: '/tripFuture', component: TripFuture, meta: {
    requiresAuth: false
  } },
  { path: '/tripHistory', component: TripHistory, meta: {
    requiresAuth: false
  } },
  { path: '/tripNext', component: TripNext, meta: {
    requiresAuth: false
  } },
  { path: '/clientSupport', component: ClientSupport },
  { path: '/driverLogin', component: DriverAuth },
  { path: '/driverRegister', component: DriverAuth },
  { path: '/driverDashboard', component: DriverHome, meta: {
    requiresDriverAuth: true
  } },
  { path: '/driverMap', component: DriverMap, meta: {
    requiresDriverAuth: true
  } },
  { path: '/driverProfile', component: DriverProfile, meta: {
    requiresDriverAuth: true
  } },
  { path: '/driverChat', component: DriverChat, meta: {
    requiresDriverAuth: true
  } },
  { path: '/driverSupport', component: DriverSupport },
  { path: '/adminLogin', component: AdminAuth },
  { path: '/admin', redirect: '/adminDashboard' },
  { path: '/adminDashboard', component: AdminDashboard, meta: { requiresAdminAuth: true } },
  { path: '/adminDrivers', component: AdminDrivers, meta: { requiresAdminAuth: true } },
  { path: '/adminDrivers/:driverId', component: AdminDriverDetail, props: true, meta: { requiresAdminAuth: true } },
  { path: '/adminOrders', component: AdminOrders, meta: { requiresAdminAuth: true } },
  { path: '/adminDistricts', component: AdminDistricts, meta: { requiresAdminAuth: true } },
  { path: '/adminDistricts/boundaries', component: AdminDistrictBoundaries, meta: { requiresAdminAuth: true } },
  { path: '/adminMonitoring', component: AdminMap, meta: { requiresAdminAuth: true } },
  { path: '/adminReports', component: AdminReports, meta: { requiresAdminAuth: true } },
  { path: '/adminChat', component: AdminChatList, meta: { requiresAdminAuth: true } },
  { path: '/adminChat/:driverId', component: AdminChatPage, props: true, meta: { requiresAdminAuth: true } }
]

const router = new Router({
  mode: 'history',
  base: process.env.BASE_URL,
  routes
})

router.beforeEach(async (to, from, next) => {
  // New driver panel: real auth against the JWT backend (see /backend),
  // replacing Firebase for this part of the app.
  const requiresDriverAuth = to.matched.some(record => record.meta.requiresDriverAuth);
  const isDriverAuthenticated = store.getters['driverAuth/isAuthenticated'];

  if (requiresDriverAuth && !isDriverAuthenticated) {
    next('/driverLogin');
    return;
  }
  if ((to.path === '/driverLogin' || to.path === '/driverRegister') && isDriverAuthenticated) {
    next('/driverDashboard');
    return;
  }

  // New admin panel: same JWT backend, separate session/token storage from
  // the driver panel (see services/adminAuth.js) so one browser can't mix
  // up which role's token is being sent where.
  const requiresAdminAuth = to.matched.some(record => record.meta.requiresAdminAuth);
  const isAdminAuthenticated = store.getters['adminAuth/isAuthenticated'];

  if (requiresAdminAuth && !isAdminAuthenticated) {
    next('/adminLogin');
    return;
  }
  if (to.path === '/adminLogin' && isAdminAuthenticated) {
    next('/adminDashboard');
    return;
  }
  // The driver panel used to be forced into dark mode unconditionally here
  // (ink-* surfaces had no light equivalents at all). It now has a real
  // light/dark/system toggle of its own (see driver/components/
  // DriverThemeToggle.vue, same ui/setPreference store action the admin
  // panel's AdminThemeToggle.vue already used) - no forcing needed any more.

  // Everything else still runs on the pre-existing Firebase auth check
  // until it is migrated too (see migration plan, Этап 4).
  const requiresAuth = to.matched.some(record => record.meta.requiresAuth);
  if (requiresAuth && !await firebase.getCurrentUser()) {
    next('login');
  } else {
    next();
  }
})

export default router