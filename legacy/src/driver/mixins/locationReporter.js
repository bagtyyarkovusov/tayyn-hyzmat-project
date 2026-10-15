// Shared by every driver screen that needs the device's GPS running and
// reporting to the backend (DriverHome for the GPS/network status icons,
// DriverMap for the live marker) - extracted so both mount the SAME watcher
// behavior instead of two independently-drifting copies.
import apiClient from '@/services/apiClient'
import { createGeoWatcher, tryOpenAndroidLocationSettings } from '@/services/geo'
import { watchNetwork } from '@/services/network'

const MAX_QUEUE_LENGTH = 20
// "Отправляться каждые несколько секунд": watchPosition fires on its own
// schedule (every meaningful movement - sometimes many times a second while
// driving); this timer is what actually decides the network-send cadence,
// decoupled from how often the device happens to report a new fix.
const LOCATION_SEND_INTERVAL_MS = 5000

// TEMPORARY, per explicit request: the blocking "Включите GPS" modal
// (GpsRequiredModal) is switched off - GPS is still watched/reported/shown
// in the status pill exactly as before, this only stops it from blocking
// the rest of the screen when off. Flip back to `true` to restore the hard
// requirement.
export const GPS_REQUIREMENT_ENABLED = false

export default {
  data() {
    return {
      gpsOn: null, // null = not evaluated yet, true/false = known state
      isOnline: navigator.onLine,
      enablingGps: false,
      gpsHint: false,
      latestPosition: null,
      locationQueue: [],
      flushingQueue: false,
      geoWatcher: null,
      stopNetworkWatcher: null,
      locationTimer: null
    }
  },
  computed: {
    // Drives StatusPill's 3-state visual (emerald/amber/red, see redesign
    // spec §3/§17). gpsOn stays `null` for a brief moment on load before
    // the geo watcher reports in - that's "warning" (amber), not "off"
    // (red), so the icon doesn't flash red on every screen mount.
    gpsState() {
      if (this.gpsOn === true) return 'on'
      if (this.gpsOn === false) return 'off'
      return 'warning'
    },
    networkState() {
      return this.isOnline ? 'on' : 'off'
    },
    showGpsRequiredModal() {
      return GPS_REQUIREMENT_ENABLED && this.gpsOn === false
    }
  },
  watch: {
    isOnline(online) {
      if (online) this.flushLocationQueue()
    }
  },
  mounted() {
    this.geoWatcher = createGeoWatcher({
      onUpdate: (payload) => {
        this.latestPosition = payload
        // Mirror into the store too - ActiveOrderPanel isn't a screen using
        // this mixin but still needs a start point for its navigation link.
        this.$store.dispatch('driverAuth/applyLocationSample', payload)
        if (this.onLocationSample) this.onLocationSample(payload) // optional hook for subclasses/screens
      },
      onStatusChange: (active) => {
        this.gpsOn = active
      }
    })
    this.geoWatcher.start()

    this.stopNetworkWatcher = watchNetwork((online) => {
      this.isOnline = online
    })

    this.locationTimer = window.setInterval(this.sendLocationTick, LOCATION_SEND_INTERVAL_MS)
  },
  beforeDestroy() {
    if (this.geoWatcher) this.geoWatcher.stop()
    if (this.stopNetworkWatcher) this.stopNetworkWatcher()
    window.clearInterval(this.locationTimer)
  },
  methods: {
    // Fires every LOCATION_SEND_INTERVAL_MS regardless of connectivity: the
    // point is captured into the queue either way ("GPS продолжает
    // сохраняться" while offline), only the actual network write depends on
    // being online.
    sendLocationTick() {
      if (!this.latestPosition) return
      this.locationQueue.push(this.latestPosition)
      if (this.locationQueue.length > MAX_QUEUE_LENGTH) {
        this.locationQueue.splice(0, this.locationQueue.length - MAX_QUEUE_LENGTH)
      }
      this.flushLocationQueue()
    },
    flushLocationQueue() {
      if (!this.isOnline || this.flushingQueue || this.locationQueue.length === 0) return
      this.flushingQueue = true
      const next = this.locationQueue[0]
      apiClient
        .post('/driver/location', next)
        .then((response) => {
          this.locationQueue.shift()
          // Backend may have just reassigned the driver's district based on
          // this exact point (driver.service.js#updateLocation) - keep the
          // store in sync so "own district" checks elsewhere (district-tap
          // accept flow) aren't working off a stale value from login.
          if (response.data && response.data.districtId !== undefined) {
            this.$store.dispatch('driverAuth/applyLocationDistrict', response.data.districtId)
          }
        })
        .catch(() => {
          // Leave it queued - will retry on the next position update or
          // the next 'online' transition.
        })
        .finally(() => {
          this.flushingQueue = false
          if (this.locationQueue.length) this.flushLocationQueue()
        })
    },
    onGpsIconClick() {
      if (this.gpsOn === false) this.handleEnableGps()
    },
    async handleEnableGps() {
      this.enablingGps = true
      this.gpsHint = false

      const openedNativeSettings = tryOpenAndroidLocationSettings()
      if (openedNativeSettings) {
        // The page is about to navigate away to the OS settings screen.
        window.setTimeout(() => {
          this.enablingGps = false
        }, 1500)
        return
      }

      const enabled = await this.geoWatcher.requestEnable()
      this.enablingGps = false
      if (!enabled) this.gpsHint = true
    }
  }
}
