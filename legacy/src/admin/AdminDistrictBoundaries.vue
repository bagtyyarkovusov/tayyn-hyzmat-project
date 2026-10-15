<template>
  <div class="flex min-h-screen flex-col bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-slate-800 dark:bg-slate-950">
      <div class="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <div class="flex items-center gap-3">
          <router-link to="/adminDistricts" class="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900">
            <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5"><path d="M15 5 8 12l7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </router-link>
          <div>
            <h1 class="text-lg font-semibold">Границы районов</h1>
            <p class="text-xs text-slate-500">Диспетчеризация будет определять район по попаданию в границу, а не по ближайшему центру</p>
          </div>
        </div>
        <AdminThemeToggle class="md:hidden" />
      </div>
    </header>

    <main class="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-4 pb-safe-mobile-nav sm:px-6 lg:flex-row">
      <!-- District list + reference text - the Turkmen boundary description
           you gave stays visible right next to the map you're editing, so
           there's no need to scroll back through chat while dragging points. -->
      <aside class="flex flex-shrink-0 flex-col gap-3 lg:w-72">
        <div class="rounded-2xl border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900">
          <button
            v-for="d in districts"
            :key="d.id"
            type="button"
            class="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors duration-150"
            :class="d.id === selectedId ? 'bg-indigo-500 bg-opacity-10 text-indigo-600 dark:text-indigo-400' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'"
            @click="selectDistrict(d.id)"
          >
            <span class="h-2.5 w-2.5 flex-shrink-0 rounded-full" :style="{ backgroundColor: colorFor(d.id) }" />
            <span class="min-w-0 flex-1 truncate">{{ d.name }}</span>
            <span v-if="d.boundary" class="flex-shrink-0 text-xs text-emerald-600 dark:text-emerald-400">✓</span>
            <span v-else class="flex-shrink-0 text-xs text-slate-400">черновик</span>
          </button>
        </div>

        <div v-if="selectedDistrict" class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p class="text-xs font-semibold text-slate-500">Описание границы (ваш текст)</p>
          <p class="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-slate-700 dark:text-slate-300">{{ referenceText }}</p>
        </div>

        <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p class="text-xs leading-relaxed text-slate-500">
            Перетаскивайте точки на карте, чтобы подогнать границу под реальные улицы. Клик по середине ребра добавляет новую точку. Чёрновик (пунктир) — примерная окружность вокруг центра района, ещё не сохранённая.
          </p>
          <button
            type="button"
            class="mt-3 w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-indigo-500 disabled:opacity-50"
            :disabled="!selectedId || saving"
            @click="save"
          >
            {{ saving ? 'Сохраняем…' : 'Сохранить границу' }}
          </button>
          <button
            type="button"
            class="mt-2 w-full rounded-xl border border-slate-200 py-2.5 text-sm font-medium text-slate-500 transition-colors duration-150 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-800"
            :disabled="!selectedId || saving"
            @click="resetToDraft"
          >
            Сбросить к черновику
          </button>
          <p v-if="error" class="mt-2 text-xs text-red-600 dark:text-red-400">{{ error }}</p>
          <p v-if="saved" class="mt-2 text-xs text-emerald-600 dark:text-emerald-400">Сохранено</p>
        </div>
      </aside>

      <div class="relative min-h-[60vh] flex-1 overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800">
        <div ref="mapContainer" class="absolute inset-0" />
        <p v-if="mapError" class="absolute inset-0 flex items-center justify-center bg-slate-100 p-6 text-center text-sm text-slate-500 dark:bg-slate-900 dark:text-slate-400">{{ mapError }}</p>
        <div v-else-if="loading" class="absolute inset-0 flex items-center justify-center bg-slate-50 bg-opacity-70 dark:bg-slate-950 dark:bg-opacity-60">
          <p class="text-sm text-slate-500 dark:text-slate-400">Загружаем районы…</p>
        </div>
      </div>
    </main>

    <AdminNav />
  </div>
</template>

<script>
import { loadYandexMaps, hasYandexMapsApiKey } from '@/services/yandexMaps'
import adminApiClient from '@/services/adminApiClient'
import AdminNav from './components/AdminNav.vue'
import AdminThemeToggle from './components/AdminThemeToggle.vue'

const ASHGABAT_CENTER = [37.9601, 58.3261]
const CITY_ZOOM = 12

// Distinct, stable per-district colors - assigned by index into the sorted
// list (same order every load), not by name, so a color doesn't shift
// around just because a district was renamed.
const PALETTE = ['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#06b6d4', '#ec4899', '#8b5cf6', '#84cc16', '#f97316']

// Verbatim regrouping of the boundary description you gave per district
// (matched by exact district name) - shown next to the map purely as a
// reference while dragging points, not parsed or trusted for coordinates.
const REFERENCE_TEXT = {
  Мир: 'Mira giryan yeri\nAytakow shayoly\nSahyoly arcabil sag tarapam katowski karta boyunca seredende',
  Микрорайон: 'Mikrayonlar\nAytakowdan gurbansolta aralyk\nMagistralny bn mir aralyk',
  '30мкр, Гуртлы': '30 gurtly\n1 may cehow gurbansoltana cenli\nBeylesem cehowdan kone gurtly cenli',
  'Хитровка, Бедев': 'Hitrowka bedew\nGurbansoltandan obyeznoya cenli beylesem bedew bn gagarin aralyk',
  'Чоганлы, Гарадамак': 'Coganly garadamak obyeznoydan asak tarapy garadamakdan cogalny',
  Центр: 'Centr shayoly bilen cehow aralyk\nYokarsy maskowski asagam gurbansoltan',
  'Ачабил, Бекреве': 'Arcabilem dusnukli bekrewani 1 maydan yokarsyny goymaly',
  'Анау, Гами': 'Anew gami gurbansoltan magistralnydan anarsy',
  'Аркадаг, Ялкым': 'Arkadag yalkymam kone gurtlydan anarsy'
}

// A rounded starting shape around a district's existing center/radius (the
// same two fields the old nearest-center matching already used) - just
// something reasonable to drag from instead of a blank map. NOT an attempt
// to guess real street boundaries - see the chat message this screen was
// built from for why that's deliberately left to you, on the real map,
// rather than auto-generated.
function draftRing(centerLat, centerLng, radiusKm, points = 14) {
  const latDegPerKm = 1 / 111.32
  const lngDegPerKm = 1 / (111.32 * Math.cos((centerLat * Math.PI) / 180))
  const ring = []
  for (let i = 0; i < points; i++) {
    const angle = (2 * Math.PI * i) / points
    ring.push([centerLat + Math.sin(angle) * radiusKm * latDegPerKm, centerLng + Math.cos(angle) * radiusKm * lngDegPerKm])
  }
  return ring
}

export default {
  name: 'AdminDistrictBoundaries',
  components: { AdminNav, AdminThemeToggle },
  data() {
    return {
      districts: [],
      selectedId: '',
      loading: true,
      mapError: '',
      saving: false,
      error: '',
      saved: false,
      ymaps: null,
      map: null,
      polygons: {} // districtId -> ymaps.Polygon
    }
  },
  computed: {
    selectedDistrict() {
      return this.districts.find((d) => d.id === this.selectedId) || null
    },
    referenceText() {
      return this.selectedDistrict ? REFERENCE_TEXT[this.selectedDistrict.name] || '' : ''
    }
  },
  async mounted() {
    if (!hasYandexMapsApiKey()) {
      this.mapError = 'Карта недоступна: не задан ключ Yandex Maps API'
      this.loading = false
      return
    }
    try {
      const [ymaps] = await Promise.all([loadYandexMaps(), this.fetchDistricts()])
      this.ymaps = ymaps
      this.initMap()
    } catch (err) {
      this.mapError = err.message || 'Не удалось загрузить карту'
    } finally {
      this.loading = false
    }
  },
  beforeDestroy() {
    if (this.map) this.map.destroy()
  },
  methods: {
    async fetchDistricts() {
      const { data } = await adminApiClient.get('/admin/districts')
      this.districts = data
    },
    colorFor(districtId) {
      const index = this.districts.findIndex((d) => d.id === districtId)
      return PALETTE[index % PALETTE.length]
    },
    ringFor(district) {
      if (district.boundary && district.boundary[0] && district.boundary[0].length >= 3) return district.boundary[0]
      return draftRing(Number(district.centerLat), Number(district.centerLng), Number(district.radiusKm) || 5)
    },
    initMap() {
      this.map = new this.ymaps.Map(this.$refs.mapContainer, { center: ASHGABAT_CENTER, zoom: CITY_ZOOM, controls: ['zoomControl'] })
      this.districts.forEach((d) => this.addPolygon(d))
      if (this.districts.length) this.selectDistrict(this.districts[0].id)
    },
    addPolygon(district) {
      const isDraft = !district.boundary
      const color = this.colorFor(district.id)
      const polygon = new this.ymaps.Polygon(
        [this.ringFor(district)],
        {},
        {
          fillColor: `${color}33`,
          strokeColor: color,
          strokeWidth: 2,
          strokeStyle: isDraft ? 'shortdash' : 'solid'
        }
      )
      this.map.geoObjects.add(polygon)
      this.polygons[district.id] = polygon
    },
    selectDistrict(id) {
      if (this.selectedId && this.polygons[this.selectedId]) {
        this.polygons[this.selectedId].editor.stopEditing()
      }
      this.selectedId = id
      this.error = ''
      this.saved = false
      const polygon = this.polygons[id]
      if (polygon) {
        polygon.editor.startEditing()
        this.map.setBounds(polygon.geometry.getBounds(), { checkZoomRange: true, zoomMargin: 40 })
      }
    },
    // Discards in-progress edits on the map and puts the draft circle back
    // (does NOT touch what's saved on the server until "Сохранить" is
    // pressed again) - for when dragging has gone wrong and starting over
    // is easier than undoing point by point.
    resetToDraft() {
      const district = this.selectedDistrict
      if (!district) return
      const ring = draftRing(Number(district.centerLat), Number(district.centerLng), Number(district.radiusKm) || 5)
      this.polygons[district.id].geometry.setCoordinates([ring])
    },
    async save() {
      const district = this.selectedDistrict
      const polygon = this.polygons[this.selectedId]
      if (!district || !polygon) return
      const coordinates = polygon.geometry.getCoordinates()
      if (!coordinates[0] || coordinates[0].length < 3) {
        this.error = 'Нужно минимум 3 точки'
        return
      }
      this.saving = true
      this.error = ''
      this.saved = false
      try {
        const { data } = await adminApiClient.patch(`/admin/districts/${district.id}/boundary`, { boundary: coordinates })
        const index = this.districts.findIndex((d) => d.id === district.id)
        this.$set(this.districts, index, data)
        // Now that it's a real saved boundary (not a draft), switch the
        // stroke from dashed to solid to match.
        polygon.options.set('strokeStyle', 'solid')
        this.saved = true
      } catch (err) {
        this.error = (err.response && err.response.data && err.response.data.message) || 'Не удалось сохранить'
      } finally {
        this.saving = false
      }
    }
  }
}
</script>
