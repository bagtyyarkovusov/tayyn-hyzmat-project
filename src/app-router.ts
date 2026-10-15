import { createRouter, createWebHistory } from 'vue-router'
import { adminSession, driverSession } from '@/features/auth/session'
import AuthPage from '@/features/auth/AuthPage.vue'
import { dispatcherRoutes } from '@/features/dispatcher/routes'
import { driverRoutes } from '@/features/driver/routes'
const legacyPaths = ['map','login','clientLogin','clientRegister','clientDashboard','clientProfile','newPickup','editPickup','tripFuture','tripHistory','tripNext','clientSupport']
export function makeRouter(driverOnly = false) {
  const router = createRouter({ history: createWebHistory(), routes: [
    { path: '/', redirect: driverOnly ? '/driverDashboard' : '/adminDashboard' },
    { path: '/admin', redirect: '/adminDashboard' },
    { path: '/adminLogin', component: AuthPage }, { path: '/driverLogin', component: AuthPage }, { path: '/driverRegister', component: AuthPage },
    ...(!driverOnly ? dispatcherRoutes : []), ...driverRoutes,
    ...legacyPaths.map(path => ({ path: `/${path}`, component: { render: () => null }, beforeEnter: () => { window.location.assign(`/legacy/${path}${window.location.search}${window.location.hash}`); return false } })),
    { path: '/:pathMatch(.*)*', redirect: driverOnly ? '/driverDashboard' : '/adminDashboard' }
  ] })
  let adminRestored = false; let driverRestored = false
  router.beforeEach(async to => {
    const admin = to.path.startsWith('/admin') && to.path !== '/adminLogin'
    const driver = to.path.startsWith('/driver') && !['/driverLogin', '/driverRegister', '/driverSupport'].includes(to.path)
    if (admin) { if (!adminRestored) { await adminSession.restore(); adminRestored = true } if (!adminSession.state.accessToken) return '/adminLogin' }
    if (driver) { if (!driverRestored) { await driverSession.restore(); driverRestored = true } if (!driverSession.state.accessToken) return '/driverLogin' }
  })
  return router
}
