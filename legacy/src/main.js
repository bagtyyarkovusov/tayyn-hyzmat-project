import Vue from 'vue'
import App from '@/App.vue'
import '@/registerServiceWorker'
import router from '@/router'
import store from '@/store'
import vuetify from '@/plugins/vuetify';
import "@/plugins/vue2-leaflet";
import "@/plugins/vuefire";
import '@/assets/tailwind.css';

Vue.config.productionTip = false;

// Theme must be resolved before first paint (avoids a light->dark flash),
// and an existing session (JWT in localStorage) must be restored before the
// router's navigation guard runs its first check. Both hydrate calls are
// harmless no-ops when their respective tokens aren't present - driver and
// admin are meant to be different browser sessions in practice, but if a
// browser somehow holds both, whichever hydrates last "wins" the shared
// socket connection (see services/socketClient.js) until that panel is used.
store.dispatch('ui/init');
store.dispatch('driverAuth/hydrate');
store.dispatch('adminAuth/hydrate');

new Vue({
  router,
  store,
  vuetify,
  render: h => h(App)
}).$mount('#app')
