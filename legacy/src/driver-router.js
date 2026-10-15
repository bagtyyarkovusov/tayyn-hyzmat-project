import Vue from 'vue'
import Router from 'vue-router'
import store from '@/store'
import DriverAuth from '@/driver/DriverAuth'
import DriverHome from '@/driver/DriverHome'
import DriverMap from '@/driver/DriverMap'
import DriverProfile from '@/driver/DriverProfile'
import DriverChat from '@/driver/DriverChat'

// A separate, driver-only router - used only by the APK build (see
// main-driver.js / vue.config.js `pages.driver`). Deliberately does NOT
// import router/index.js: that file pulls in Firebase, Vuetify, Leaflet and
// every legacy client/admin page just to resolve its route table, which
// would defeat the entire point of a lean, driver-only native bundle even
// though none of those routes are reachable from here.
Vue.use(Router)

const routes = [
  { path: '/', redirect: '/driverDashboard' },
  { path: '/driverLogin', component: DriverAuth },
  { path: '/driverRegister', component: DriverAuth },
  { path: '/driverDashboard', component: DriverHome, meta: { requiresDriverAuth: true } },
  { path: '/driverMap', component: DriverMap, meta: { requiresDriverAuth: true } },
  { path: '/driverProfile', component: DriverProfile, meta: { requiresDriverAuth: true } },
  { path: '/driverChat', component: DriverChat, meta: { requiresDriverAuth: true } }
]

const router = new Router({
  mode: 'history',
  base: process.env.BASE_URL,
  routes
})

router.beforeEach((to, from, next) => {
  const requiresDriverAuth = to.matched.some((record) => record.meta.requiresDriverAuth)
  const isDriverAuthenticated = store.getters['driverAuth/isAuthenticated']

  if (requiresDriverAuth && !isDriverAuthenticated) {
    next('/driverLogin')
    return
  }
  if ((to.path === '/driverLogin' || to.path === '/driverRegister') && isDriverAuthenticated) {
    next('/driverDashboard')
    return
  }
  next()
})

export default router
