<template>
  <section class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-ink-600 dark:bg-ink-800">
    <div class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-2">
        <!-- flex-shrink-0 so this stays a 32x32 square: without it a long
             heading next to it can squeeze the icon into a sliver. -->
        <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl" :class="statusMeta.iconClass">
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4">
            <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            <circle cx="12" cy="9.5" r="2.4" stroke="currentColor" stroke-width="1.8" />
          </svg>
        </div>
        <h2 class="truncate text-sm font-semibold text-slate-700 dark:text-slate-200">Ваше текущее местоположение</h2>
      </div>
      <span class="flex flex-shrink-0 items-center gap-1.5 text-xs font-medium" :class="statusMeta.textClass">
        <span class="h-1.5 w-1.5 flex-shrink-0 rounded-full" :class="statusMeta.dotClass" />
        {{ statusMeta.label }}
      </span>
    </div>

    <transition name="fade" mode="out-in">
      <div v-if="position" key="address" class="mt-3">
        <p class="text-sm font-semibold text-slate-900 dark:text-slate-100">
          <svg v-if="geocoding" class="mr-1 inline h-3.5 w-3.5 animate-spin align-middle text-slate-400" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
          </svg>
          {{ address || `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}` }}
        </p>
      </div>
      <p v-else key="empty" class="mt-3 text-xs text-slate-500">{{ statusMeta.hint }}</p>
    </transition>

    <p v-if="position" class="mt-2 text-xs text-slate-500">Updated {{ relativeLabel }}</p>
  </section>
</template>

<script>
import { reverseGeocode } from '@/services/geocoding'

// Don't re-geocode on every single GPS tick (locationReporter.js updates
// `position` roughly every 5s) - only when the driver has actually moved a
// meaningful distance, and never more often than once per
// GEOCODE_MIN_INTERVAL_MS regardless. This now calls the public Nominatim
// service (see services/geocoding.js), which has its own ~1req/s usage
// policy independent of any project API key - the throttle matters even
// more here than it did with Yandex.
const GEOCODE_MIN_INTERVAL_MS = 20000
const GEOCODE_MIN_DISTANCE_KM = 0.05 // ~50m

function approxDistanceKm(a, b) {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export default {
  name: 'GpsInfoCard',
  props: {
    // 'on' | 'off' | 'warning' - the same tri-state the GPS pill shows
    // (locationReporter.js#gpsState). This used to be a plain boolean fed
    // `gpsOn === true`, which collapsed "not determined yet" into "выключен"
    // - so the pill could read amber "ищем" while this card flatly said
    // "GPS выключен" about the very same state.
    state: { type: String, default: 'warning' },
    // { lat, lng, recordedAt } - the same payload locationReporter.js's
    // geo watcher hands to every screen, no separate fetch/mock data.
    position: { type: Object, default: null }
  },
  data() {
    return {
      now: Date.now(),
      tickTimer: null,
      address: '',
      geocoding: false,
      lastGeocodedAt: 0,
      lastGeocodedAtPos: null
    }
  },
  computed: {
    statusMeta() {
      if (this.state === 'on') {
        return {
          label: 'GPS активен',
          hint: 'Ожидаем сигнал GPS…',
          iconClass: 'bg-brand-500 bg-opacity-10 text-brand-600 dark:text-brand-400',
          textClass: 'text-brand-700 dark:text-brand-400',
          dotClass: 'bg-brand-500'
        }
      }
      if (this.state === 'off') {
        return {
          label: 'GPS выключен',
          hint: 'Включите геолокацию, чтобы определить местоположение',
          iconClass: 'bg-red-500 bg-opacity-10 text-red-600 dark:text-red-400',
          textClass: 'text-red-700 dark:text-red-400',
          dotClass: 'bg-red-500'
        }
      }
      return {
        label: 'Ищем сигнал',
        hint: 'Ищем сигнал GPS…',
        iconClass: 'bg-amber-500 bg-opacity-10 text-amber-700 dark:text-amber-400',
        textClass: 'text-amber-700 dark:text-amber-400',
        dotClass: 'bg-amber-500'
      }
    },
    relativeLabel() {
      if (!this.position || !this.position.recordedAt) return '—'
      const seconds = Math.max(0, Math.floor((this.now - new Date(this.position.recordedAt).getTime()) / 1000))
      if (seconds < 60) return `${seconds} sec ago`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes} min ago`
      const hours = Math.floor(minutes / 60)
      return `${hours} h ago`
    }
  },
  watch: {
    position: {
      immediate: true,
      handler(pos) {
        if (pos) this.maybeReverseGeocode(pos)
      }
    }
  },
  mounted() {
    this.tickTimer = window.setInterval(() => {
      this.now = Date.now()
    }, 1000)
  },
  beforeDestroy() {
    window.clearInterval(this.tickTimer)
  },
  methods: {
    async maybeReverseGeocode(pos) {
      const nowMs = Date.now()
      const dueForRefresh = nowMs - this.lastGeocodedAt >= GEOCODE_MIN_INTERVAL_MS
      const movedEnough = !this.lastGeocodedAtPos || approxDistanceKm(this.lastGeocodedAtPos, pos) >= GEOCODE_MIN_DISTANCE_KM
      if (this.geocoding || !dueForRefresh || !movedEnough) return

      this.geocoding = true
      this.lastGeocodedAt = nowMs
      this.lastGeocodedAtPos = { lat: pos.lat, lng: pos.lng }
      try {
        const line = await reverseGeocode(pos.lat, pos.lng)
        if (line) this.address = line
      } catch (err) {
        // Silent - the raw coordinates fallback in the template already
        // covers this (offline, API hiccup, no key configured...).
      } finally {
        this.geocoding = false
      }
    }
  }
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter,
.fade-leave-to {
  opacity: 0;
}
</style>
