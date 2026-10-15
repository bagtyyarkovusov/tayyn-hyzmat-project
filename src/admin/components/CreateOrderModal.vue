<template>
  <transition name="modal-fade" appear>
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-black bg-opacity-70 backdrop-blur-sm sm:items-center">
      <div class="flex max-h-90vh w-full max-w-lg flex-col rounded-t-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:max-w-3xl sm:rounded-3xl">
        <div class="flex flex-shrink-0 items-center justify-between p-5 pb-3">
          <div>
            <h2 class="text-lg font-bold text-slate-900 dark:text-white">Новый заказ (ручной)</h2>
            <p class="mt-0.5 text-xs text-slate-500">Диспетчеризация по телефону — заказ уходит водителям выбранного района, как обычный заказ.</p>
          </div>
          <button type="button" class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" @click="$emit('close')">
            <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
          </button>
        </div>

        <!-- "Создать заказ" used to live inside this scrolling area, at the
             very bottom of a long form - reaching it meant scrolling past
             the map first. It's now a fixed footer below (always visible,
             no scrolling needed), and the map moves to its own column on
             sm:+ instead of stacking above the form. -->
        <div class="min-h-0 flex-1 overflow-y-auto sm:flex sm:flex-row sm:overflow-hidden">
          <div class="flex-shrink-0 px-5 sm:w-72 sm:overflow-y-auto sm:border-r sm:border-slate-200 sm:px-5 sm:py-1 dark:sm:border-slate-800">
            <div class="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-950">
              <button
                type="button"
                class="flex-1 rounded-lg py-2 text-sm font-medium transition-colors duration-150"
                :class="pickMode === 'pickup' ? 'bg-white text-slate-900 shadow dark:bg-slate-800 dark:text-white' : 'text-slate-500'"
                @click="pickMode = 'pickup'"
              >
                ● Откуда {{ pickup ? '✓' : '' }}
              </button>
              <button
                type="button"
                class="flex-1 rounded-lg py-2 text-sm font-medium transition-colors duration-150"
                :class="pickMode === 'dropoff' ? 'bg-white text-slate-900 shadow dark:bg-slate-800 dark:text-white' : 'text-slate-500'"
                @click="pickMode = 'dropoff'"
              >
                ■ Куда {{ dropoff ? '✓' : '' }}
              </button>
            </div>
            <p class="mt-1.5 text-center text-xs text-slate-500">
              Точка на карте не обязательна, если выбран район справа - нажмите, чтобы уточнить «{{ pickMode === 'pickup' ? 'Откуда' : 'Куда' }}»
            </p>

            <div class="relative mt-2 h-56 overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 sm:h-80">
              <div ref="mapContainer" class="absolute inset-0" />
              <p v-if="mapError" class="absolute inset-0 flex items-center justify-center bg-slate-100 p-4 text-center text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">{{ mapError }}</p>
            </div>
          </div>

          <div class="min-h-0 px-5 pb-5 pt-3 sm:flex-1 sm:overflow-y-auto sm:py-5">
            <div class="space-y-3">
              <div>
                <label class="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                  Район
                  <span v-if="districtsStatus === 'loading'" class="text-slate-400">· загружаем…</span>
                </label>
                <select
                  v-model="districtId"
                  class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
                >
                  <option value="">Определить автоматически по точке «Откуда»</option>
                  <option v-for="d in districts" :key="d.id" :value="d.id">{{ d.name }}</option>
                </select>
                <!-- Was previously a silent failure (districts/fetch's
                     error just got swallowed) - a district-selection form
                     with an empty, unexplained dropdown looks exactly like
                     "you have to click the map instead", which isn't the
                     real reason at all. -->
                <p v-if="districtsStatus === 'error'" class="mt-1 text-xs text-red-600 dark:text-red-400">
                  Не удалось загрузить районы.
                  <button type="button" class="font-semibold underline" @click="loadDistricts">Повторить</button>
                </p>
              </div>

              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                    Адрес отправления
                    <span v-if="geocodingPickup" class="text-slate-400">· определяем…</span>
                  </label>
                  <input
                    :value="pickupAddress"
                    type="text"
                    placeholder="Улица, дом"
                    class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-600"
                    @input="onPickupAddressInput"
                  />
                </div>
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                    Адрес назначения
                    <span v-if="geocodingDropoff" class="text-slate-400">· определяем…</span>
                  </label>
                  <input
                    :value="dropoffAddress"
                    type="text"
                    placeholder="Улица, дом"
                    class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-600"
                    @input="onDropoffAddressInput"
                  />
                </div>
              </div>

              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Стоимость, TMT</label>
                  <input v-model.number="price" type="number" min="0" step="0.01" placeholder="25" class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-600" />
                </div>
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Телефон клиента</label>
                  <div class="flex items-center rounded-xl border border-slate-200 bg-white pl-3 focus-within:border-indigo-500 dark:border-slate-800 dark:bg-slate-950">
                    <span class="flex-shrink-0 text-sm font-semibold text-slate-500 dark:text-slate-400">+993</span>
                    <input
                      v-model="clientPhoneLocal"
                      type="tel"
                      inputmode="numeric"
                      placeholder=" XX XXX XX XX"
                      class="w-full bg-transparent py-2 pl-1 pr-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-600"
                      @input="onClientPhoneLocalInput"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label class="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Примечание</label>
                <textarea
                  v-model.trim="note"
                  rows="2"
                  maxlength="500"
                  placeholder="Например: клиент с собакой, оплата картой, перезвонить если не берёт трубку"
                  class="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-600"
                />
              </div>
            </div>

            <p v-if="error" class="mt-3 text-xs text-red-600 dark:text-red-400">{{ error }}</p>
          </div>
        </div>

        <div class="flex flex-shrink-0 gap-2 border-t border-slate-200 p-5 dark:border-slate-800">
          <button type="button" class="flex-1 rounded-2xl border border-slate-200 py-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800" @click="$emit('close')">
            Отмена
          </button>
          <button
            type="button"
            class="flex-1 rounded-2xl bg-indigo-600 py-3 text-sm font-semibold text-white transition-colors duration-150 hover:bg-indigo-500 disabled:opacity-50"
            :disabled="(!pickup && !districtId) || submitting"
            @click="submit"
          >
            {{ submitting ? 'Создаём…' : 'Создать заказ' }}
          </button>
        </div>
      </div>
    </div>
  </transition>
</template>

<script>
import { loadYandexMaps, hasYandexMapsApiKey } from '@/services/yandexMaps'
import { reverseGeocode } from '@/services/geocoding'
import adminApiClient from '@/services/adminApiClient'

const ASHGABAT_CENTER = [37.9601, 58.3261]
const CITY_ZOOM = 12

export default {
  name: 'CreateOrderModal',
  data() {
    return {
      pickMode: 'pickup',
      pickup: null, // { lat, lng }
      dropoff: null,
      pickupAddress: '',
      dropoffAddress: '',
      // Tracks whether the admin typed into an address field themselves -
      // auto-fill from reverse geocoding (below) never overwrites that,
      // only ever fills a field that's still empty/still its own guess.
      pickupAddressEdited: false,
      dropoffAddressEdited: false,
      geocodingPickup: false,
      geocodingDropoff: false,
      price: null,
      clientPhoneLocal: '',
      note: '',
      districtId: '',
      submitting: false,
      error: '',
      mapError: '',
      ymaps: null,
      map: null,
      pickupPlacemark: null,
      dropoffPlacemark: null
    }
  },
  computed: {
    // Same shared `districts` Vuex module the driver panel's DistrictGrid.vue
    // and admin's own AdminDistricts.vue already use - one realtime-updated
    // source, no separate fetch/mock data.
    districts() {
      return this.$store.getters['districts/sortedByName']
    },
    selectedDistrict() {
      return this.districts.find((d) => d.id === this.districtId) || null
    },
    districtsStatus() {
      return this.$store.state.districts.status
    },
    // Turkmenistan-only app - +993 is fixed, same pattern as DriverAuth.vue's
    // login/register phone field. Empty when clientPhoneLocal is empty so
    // `this.clientPhone || undefined` in submit() still treats "no phone
    // typed" as "field omitted" (it's optional - phone dispatch orders can
    // be created without a client phone on file).
    clientPhone() {
      return this.clientPhoneLocal ? `+993${this.clientPhoneLocal}` : ''
    }
  },
  watch: {
    // Selecting a district without ever clicking the map (submit() already
    // falls back to its center point for pickupLat/pickupLng - see there)
    // used to leave "Адрес отправления" blank, so the driver's "Новый
    // заказ" popup showed the raw fallback "Адрес не указан" instead of
    // anything useful. Same reverse-geocoding path as clicking the map.
    districtId(id) {
      if (!id || this.pickup || this.pickupAddressEdited) return
      const d = this.selectedDistrict
      if (d) this.maybeReverseGeocode('pickup', { lat: Number(d.centerLat), lng: Number(d.centerLng) })
    }
  },
  mounted() {
    this.loadDistricts()
    if (!hasYandexMapsApiKey()) {
      this.mapError = 'Карта недоступна: не задан ключ Yandex Maps API'
      return
    }
    loadYandexMaps()
      .then((ymaps) => this.initMap(ymaps))
      .catch((err) => {
        this.mapError = err.message
      })
  },
  beforeDestroy() {
    if (this.map) {
      this.map.destroy()
      this.map = null
    }
  },
  methods: {
    // Must pass adminApiClient - see store/modules/districts.js's comment
    // on why the default (driver) client 401s in an admin-only session,
    // which is exactly what left this dropdown silently empty before.
    // Also used as the "Повторить" retry action below.
    loadDistricts() {
      this.$store.dispatch('districts/fetch', adminApiClient).catch(() => {})
    },
    // Strips anything that isn't a digit as the admin types, same as
    // DriverAuth.vue's onPhoneLocalInput - keeps "+993" the only non-digit
    // part of the field no matter what gets pasted in.
    onClientPhoneLocalInput(event) {
      this.clientPhoneLocal = event.target.value.replace(/[^0-9]/g, '')
    },
    initMap(ymaps) {
      this.ymaps = ymaps
      this.map = new ymaps.Map(this.$refs.mapContainer, { center: ASHGABAT_CENTER, zoom: CITY_ZOOM, controls: ['zoomControl'] })
      this.map.events.add('click', (e) => {
        const coords = e.get('coords')
        this.setPoint(this.pickMode, coords)
      })
    },
    setPoint(mode, coords) {
      const point = { lat: coords[0], lng: coords[1] }
      if (mode === 'pickup') {
        this.pickup = point
        this.placeMarker('pickupPlacemark', coords, '#10b981')
      } else {
        this.dropoff = point
        this.placeMarker('dropoffPlacemark', coords, '#ef4444')
      }
      this.maybeReverseGeocode(mode, point)
    },
    onPickupAddressInput(event) {
      this.pickupAddressEdited = true
      this.pickupAddress = event.target.value
    },
    onDropoffAddressInput(event) {
      this.dropoffAddressEdited = true
      this.dropoffAddress = event.target.value
    },
    // Auto-fills "Адрес отправления"/"Адрес назначения" from the same
    // backend reverse-geocoding proxy the driver panel's GpsInfoCard.vue and
    // admin's AdminDriverDetail.vue already use (see services/geocoding.js)
    // - a map click or district selection used to leave these blank,
    // requiring the admin to type an address by hand for the driver's "Новый
    // заказ" popup to show anything but "Адрес не указан". Never overwrites
    // text the admin actually typed themselves (see the *AddressEdited flags).
    async maybeReverseGeocode(mode, point) {
      const edited = mode === 'pickup' ? this.pickupAddressEdited : this.dropoffAddressEdited
      if (edited) return
      const busyFlag = mode === 'pickup' ? 'geocodingPickup' : 'geocodingDropoff'
      this[busyFlag] = true
      try {
        const address = await reverseGeocode(point.lat, point.lng, adminApiClient)
        // Re-check after the await - the admin may have typed their own
        // address (or the map moved on again) while this request was out.
        const stillEdited = mode === 'pickup' ? this.pickupAddressEdited : this.dropoffAddressEdited
        if (address && !stillEdited) {
          if (mode === 'pickup') this.pickupAddress = address
          else this.dropoffAddress = address
        }
      } catch (err) {
        // Silent - the address field just stays as-is, same as any other
        // optional field the admin can still fill in by hand.
      } finally {
        this[busyFlag] = false
      }
    },
    placeMarker(key, coords, color) {
      if (this[key]) {
        this[key].geometry.setCoordinates(coords)
        return
      }
      this[key] = new this.ymaps.Placemark(coords, {}, { iconColor: color, preset: 'islands#circleIcon' })
      this.map.geoObjects.add(this[key])
    },
    async submit() {
      // Coordinates are sent ONLY when the admin actually clicked a point on
      // the map. Otherwise they're omitted entirely and the backend fills in
      // the chosen district's centre itself (orders.service.js#createOrder).
      // This used to compute that centre here from `selectedDistrict`, but
      // GET /districts didn't return centerLat/centerLng - so it sent
      // Number(undefined) = NaN, which JSON turns into null, and every
      // district-only order died on validation with "Некорректные данные
      // запроса". Deriving it server-side means the form can't get this
      // wrong again.
      if ((!this.pickup && !this.districtId) || this.submitting) return
      this.submitting = true
      this.error = ''
      try {
        const payload = {
          ...(this.pickup ? { pickupLat: this.pickup.lat, pickupLng: this.pickup.lng } : {}),
          pickupAddress: this.pickupAddress || undefined,
          ...(this.dropoff ? { dropoffLat: this.dropoff.lat, dropoffLng: this.dropoff.lng } : {}),
          dropoffAddress: this.dropoffAddress || undefined,
          priceEstimated: this.price || undefined,
          clientPhone: this.clientPhone || undefined,
          districtId: this.districtId || undefined,
          note: this.note || undefined
        }
        await this.$store.dispatch('adminOrders/createOrder', payload)
        this.$store.dispatch('ui/pushToast', { title: 'Заказ создан', body: 'Отправлен водителям выбранного района', variant: 'success' })
        this.$emit('created')
        this.$emit('close')
      } catch (err) {
        this.error = (err.response && err.response.data && err.response.data.message) || 'Не удалось создать заказ'
      } finally {
        this.submitting = false
      }
    }
  }
}
</script>

<style scoped>
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.2s ease;
}
.modal-fade-enter,
.modal-fade-leave-to {
  opacity: 0;
}
</style>
