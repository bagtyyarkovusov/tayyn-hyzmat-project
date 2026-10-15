<template>
  <div class="flex min-h-screen flex-col bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-slate-800 dark:bg-slate-950">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
        <div>
          <h1 class="text-lg font-semibold">Карта водителей</h1>
          <p class="text-xs text-slate-500">{{ onlineCount }} online из {{ withLocationCount }} на карте</p>
        </div>
        <div class="flex items-center gap-2">
          <AdminThemeToggle class="md:hidden" />
          <span class="flex items-center gap-1.5 rounded-full bg-emerald-500 bg-opacity-10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <span class="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Live
          </span>
        </div>
      </div>
    </header>

    <div class="relative flex-1">
      <div ref="mapContainer" class="absolute inset-0" />
      <div v-if="mapError" class="absolute inset-0 flex items-center justify-center bg-slate-100 p-6 text-center dark:bg-slate-900">
        <p class="max-w-xs text-sm text-slate-500 dark:text-slate-400">{{ mapError }}</p>
      </div>
      <div v-else-if="loading" class="absolute inset-0 flex items-center justify-center bg-slate-50 bg-opacity-70 dark:bg-slate-950 dark:bg-opacity-60">
        <p class="text-sm text-slate-500 dark:text-slate-400">Загружаем водителей…</p>
      </div>
    </div>

    <AdminNav />
  </div>
</template>

<script>
import { loadYandexMaps, hasYandexMapsApiKey } from '@/services/yandexMaps'
import { getSocket } from '@/services/socketClient'
import adminApiClient from '@/services/adminApiClient'
import AdminNav from './components/AdminNav.vue'
import AdminThemeToggle from './components/AdminThemeToggle.vue'

const ASHGABAT_CENTER = [37.9601, 58.3261]
const CITY_ZOOM = 12

export default {
  name: 'AdminMap',
  components: { AdminNav, AdminThemeToggle },
  data() {
    return {
      loading: true,
      mapError: '',
      ymaps: null,
      map: null,
      drivers: [], // { id, fullName, plateNumber, isOnline }
      placemarks: {} // driverId -> Placemark
    }
  },
  computed: {
    withLocationCount() {
      return Object.keys(this.placemarks).length
    },
    onlineCount() {
      return this.drivers.filter((d) => d.isOnline && this.placemarks[d.id]).length
    }
  },
  mounted() {
    if (!hasYandexMapsApiKey()) {
      this.mapError = 'Карта недоступна: не задан ключ Yandex Maps API'
      this.loading = false
    } else {
      loadYandexMaps()
        .then((ymaps) => this.initMap(ymaps))
        .catch((err) => {
          this.mapError = err.message
          this.loading = false
        })
    }

    const socket = getSocket()
    if (socket) {
      socket.on('driver:location', this.handleLocationUpdate)
      socket.on('driver:status', this.handleStatusUpdate)
    }
  },
  beforeDestroy() {
    const socket = getSocket()
    if (socket) {
      socket.off('driver:location', this.handleLocationUpdate)
      socket.off('driver:status', this.handleStatusUpdate)
    }
    if (this.map) {
      this.map.destroy()
      this.map = null
    }
  },
  methods: {
    async initMap(ymaps) {
      this.ymaps = ymaps
      this.map = new ymaps.Map(this.$refs.mapContainer, { center: ASHGABAT_CENTER, zoom: CITY_ZOOM, controls: ['zoomControl'] })
      try {
        await this.loadDrivers()
      } catch (err) {
        this.mapError = (err.response && err.response.data && err.response.data.message) || 'Не удалось загрузить водителей'
      } finally {
        this.loading = false
      }
    },
    async loadDrivers() {
      // limit is capped at 100 by GET /admin/drivers itself
      // (listDriversQuerySchema) - asking for more just 400s the request.
      const { data } = await adminApiClient.get('/admin/drivers', { params: { status: 'APPROVED', limit: 100 } })
      this.drivers = data.items.map((d) => ({
        id: d.id,
        fullName: d.user.fullName,
        plateNumber: d.currentVehicle ? d.currentVehicle.plateNumber : '—',
        isOnline: d.isOnline
      }))
      data.items.forEach((d) => {
        if (d.lastLat != null && d.lastLng != null) {
          this.placeMarker(d.id, [Number(d.lastLat), Number(d.lastLng)], d.isOnline)
        }
      })
    },
    driverMeta(driverId) {
      return this.drivers.find((d) => d.id === driverId)
    },
    placeMarker(driverId, coords, isOnline) {
      const meta = this.driverMeta(driverId)
      const label = meta ? `${meta.fullName} · ${meta.plateNumber}` : driverId
      if (this.placemarks[driverId]) {
        this.placemarks[driverId].geometry.setCoordinates(coords)
        this.placemarks[driverId].options.set('iconColor', isOnline ? '#10b981' : '#64748b')
        return
      }
      const placemark = new this.ymaps.Placemark(
        coords,
        { balloonContentHeader: label, balloonContentBody: `<a href="/adminDrivers/${driverId}" style="color:#6366f1;">Открыть профиль →</a>` },
        { preset: 'islands#circleIcon', iconColor: isOnline ? '#10b981' : '#64748b' }
      )
      this.map.geoObjects.add(placemark)
      this.$set(this.placemarks, driverId, placemark)
    },
    handleLocationUpdate(payload) {
      // Only APPROVED drivers were loaded into `this.drivers` - a location
      // ping from anyone else (shouldn't happen, requireApprovedDriver
      // gates the endpoint that emits this) is ignored defensively.
      const meta = this.driverMeta(payload.driverId)
      if (!meta) return
      this.placeMarker(payload.driverId, [payload.lat, payload.lng], meta.isOnline)
    },
    handleStatusUpdate(payload) {
      const meta = this.driverMeta(payload.driverId)
      if (meta) meta.isOnline = payload.isOnline
      if (this.placemarks[payload.driverId]) {
        this.placemarks[payload.driverId].options.set('iconColor', payload.isOnline ? '#10b981' : '#64748b')
      }
    }
  }
}
</script>
