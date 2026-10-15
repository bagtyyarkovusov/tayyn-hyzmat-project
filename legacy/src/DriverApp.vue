<template>
  <div>
    <router-view />
    <ToastHost />
  </div>
</template>

<script>
// The driver APK's root component - deliberately just a router outlet, no
// Vuetify shell (App.vue wraps everything in <v-app>/<v-navigation-drawer>,
// which the driver screens never use - see main-driver.js for why this
// build skips Vuetify/Firebase/Leaflet entirely). ToastHost is mounted once
// here (not per-screen) so a toast survives whatever navigation happens
// while it's showing and every screen shares one visual/animation system.
import ToastHost from './driver/components/ToastHost.vue'
import { primeAudioOnFirstInteraction } from './services/notificationSound'

export default {
  name: 'DriverApp',
  components: { ToastHost },
  mounted() {
    // Unlocks the "Новый заказ" chime's AudioContext on the driver's first
    // tap anywhere (see notificationSound.js) - without this, a browser's
    // autoplay policy can leave it silently unable to ever play.
    primeAudioOnFirstInteraction()
  }
}
</script>
