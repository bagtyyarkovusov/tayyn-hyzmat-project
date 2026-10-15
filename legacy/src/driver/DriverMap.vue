<template>
  <div class="relative min-h-screen bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-ink-950 dark:text-slate-100 md:pl-60">
    <!-- Minimal floating status row instead of a full header bar - "Карта"
         title and its background/border removed, only the two status pills
         (still useful here specifically, to see GPS while looking at the
         map) float over the map itself. -->
    <div class="absolute left-3 top-3 z-20 flex items-center gap-2">
      <StatusPill :state="gpsState" label="GPS" clickable @click="onGpsIconClick" />
      <StatusPill :state="networkState" label="Internet" />
    </div>

    <div class="relative" style="height: 100vh;">
      <div ref="mapContainer" class="absolute inset-0" />

      <div v-if="mapError" class="absolute inset-0 flex items-center justify-center bg-slate-100 p-6 text-center dark:bg-ink-900">
        <div class="max-w-xs space-y-2">
          <p class="text-sm font-medium text-slate-700 dark:text-slate-300">{{ mapError }}</p>
          <p class="text-xs text-slate-500">
            Добавьте VUE_APP_YANDEX_MAPS_API_KEY в .env (бесплатный ключ на developer.tech.yandex.ru) и перезапустите приложение.
          </p>
        </div>
      </div>

      <!-- All of Yandex's own controls are deliberately off (see initMap's
           `controls: []`) for a clean map, including its stock geolocation
           button - this is that button, redrawn to match the rest of the
           app instead of Yandex's default widget style. -->
      <button
        v-else
        type="button"
        class="absolute bottom-24 right-4 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-white text-brand-600 shadow-lg transition-transform duration-150 active:scale-90 disabled:opacity-40 dark:bg-ink-800 dark:text-brand-400 md:bottom-6"
        :disabled="!hasKnownPosition"
        @click="centerOnMyLocation"
      >
        <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5">
          <circle cx="12" cy="12" r="3" fill="currentColor" />
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <BottomNav />

    <OrderOverlay />

    <GpsRequiredModal v-if="showGpsRequiredModal" :enabling="enablingGps" :show-hint="gpsHint" @enable="handleEnableGps" @logout="logout" />
  </div>
</template>

<script>
import { loadYandexMaps, hasYandexMapsApiKey } from '@/services/yandexMaps'
import { getSocket } from '@/services/socketClient'
import StatusPill from './components/StatusPill.vue'
import BottomNav from './components/BottomNav.vue'
import OrderOverlay from './components/OrderOverlay.vue'
import GpsRequiredModal from './components/GpsRequiredModal.vue'
import locationReporter from './mixins/locationReporter'

// Ashgabat's own coordinates (see backend districts seed - "Гарашсызлык"
// district center is the same point) and a city-wide zoom level, per spec.
const ASHGABAT_CENTER = [37.9601, 58.3261]
const CITY_ZOOM = 12

// A rotating arrow marker (heading) + a small white pill underneath with the
// plate number - deliberately not Yandex's own default balloon/pin, since
// the requirement is "показывать текущего водителя, номер машины,
// направление движения" as one glanceable marker, not a click-to-reveal.
const PLACEMARK_TEMPLATE =
  '<div style="position:relative;width:0;height:0;">' +
  '<div style="position:absolute;left:-17px;top:-17px;width:34px;height:34px;' +
  'transform:rotate({{ properties.heading }}deg);transform-origin:50% 50%;transition:transform 0.3s ease;">' +
  '<svg viewBox="0 0 24 24" width="34" height="34">' +
  '<circle cx="12" cy="12" r="10.5" fill="#059669" stroke="#ffffff" stroke-width="2"/>' +
  '<path d="M12 6.5 16 15 12 12.5 8 15 Z" fill="#ffffff"/>' +
  '</svg>' +
  '</div>' +
  '<div style="position:absolute;left:-45px;top:16px;width:90px;text-align:center;' +
  'font:600 11px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0f172a;' +
  'background:#ffffff;border-radius:6px;padding:2px 6px;box-shadow:0 1px 4px rgba(15,23,42,0.25);white-space:nowrap;">' +
  '{{ properties.plateNumber }}' +
  '</div>' +
  '</div>'

export default {
  name: 'DriverMap',
  components: { StatusPill, BottomNav, OrderOverlay, GpsRequiredModal },
  mixins: [locationReporter],
  data() {
    return {
      mapError: '',
      ymaps: null,
      map: null,
      placemark: null,
      PlacemarkLayout: null
    }
  },
  computed: {
    plateNumber() {
      const driver = this.$store.state.driverAuth.driver
      return driver && driver.currentVehicle ? driver.currentVehicle.plateNumber : ''
    },
    hasKnownPosition() {
      return Boolean(this.placemark || this.latestPosition)
    }
  },
  watch: {
    plateNumber(value) {
      if (this.placemark) this.placemark.properties.set('plateNumber', value || '—')
    }
  },
  mounted() {
    if (!hasYandexMapsApiKey()) {
      this.mapError = 'Карта недоступна: не задан ключ Yandex Maps API'
    } else {
      loadYandexMaps()
        .then((ymaps) => this.initMap(ymaps))
        .catch((err) => {
          this.mapError = err.message
        })
    }

    const socket = getSocket()
    if (socket) socket.on('driver:location', this.handleLocationUpdate)
  },
  beforeDestroy() {
    const socket = getSocket()
    if (socket) socket.off('driver:location', this.handleLocationUpdate)
    if (this.map) {
      this.map.destroy()
      this.map = null
    }
  },
  methods: {
    initMap(ymaps) {
      this.ymaps = ymaps
      this.PlacemarkLayout = ymaps.templateLayoutFactory.createClass(PLACEMARK_TEMPLATE)

      // "Без стандартных виджетов, чистая карта": controls: [] removes
      // every built-in Yandex UI element (zoom buttons, geolocation button,
      // type selector, ruler, fullscreen, search) - only the copyright
      // mark stays, which Yandex's terms require and cannot be hidden.
      this.map = new ymaps.Map(
        this.$refs.mapContainer,
        { center: ASHGABAT_CENTER, zoom: CITY_ZOOM, controls: [] },
        { suppressMapOpenBlock: true }
      )

      if (this.latestPosition) this.placeInitialMarker(this.latestPosition)
    },
    // Local GPS sample hook from the locationReporter mixin - used only to
    // paint the marker instantly on first fix, before the first 5s network
    // round trip completes. Every update after that comes from the
    // `driver:location` WebSocket event, per spec ("автоматически
    // обновляться через WebSocket").
    onLocationSample(payload) {
      if (this.map && !this.placemark) this.placeInitialMarker(payload)
    },
    placeInitialMarker(position) {
      if (!this.ymaps || !this.map || this.placemark) return
      this.placemark = new this.ymaps.Placemark(
        [position.lat, position.lng],
        { heading: position.heading || 0, plateNumber: this.plateNumber || '—' },
        { iconLayout: this.PlacemarkLayout, iconShape: { type: 'Circle', coordinates: [0, 0], radius: 18 } }
      )
      this.map.geoObjects.add(this.placemark)
    },
    handleLocationUpdate(payload) {
      if (!this.placemark) {
        if (this.map) this.placeInitialMarker(payload)
        return
      }
      this.placemark.geometry.setCoordinates([payload.lat, payload.lng])
      this.placemark.properties.set({ heading: payload.heading || 0, plateNumber: this.plateNumber || '—' })
    },
    centerOnMyLocation() {
      if (!this.map) return
      const coords = this.placemark ? this.placemark.geometry.getCoordinates() : [this.latestPosition.lat, this.latestPosition.lng]
      this.map.setCenter(coords, Math.max(this.map.getZoom(), 15), { duration: 300 })
    },
    logout() {
      this.$store.dispatch('driverAuth/logout')
      this.$router.replace('/driverLogin')
    }
  }
}
</script>
