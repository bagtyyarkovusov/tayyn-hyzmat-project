import Vue from 'vue'
import DriverApp from '@/DriverApp.vue'
import driverRouter from '@/driver-router'
import store from '@/store'
import '@/assets/tailwind.css'

// Entry point for the driver APK build ONLY (see vue.config.js `pages.driver`
// and capacitor.config.json `webDir`). The regular web app's main.js pulls
// in Vuetify + Firebase + Leaflet + vuefire for the legacy client/admin
// pages - none of that belongs in a driver-only native bundle, so this is a
// separate, minimal entry rather than a conditional branch inside main.js.
Vue.config.productionTip = false

store.dispatch('ui/init')
store.dispatch('driverAuth/hydrate')

new Vue({
  router: driverRouter,
  store,
  render: (h) => h(DriverApp)
}).$mount('#app')
