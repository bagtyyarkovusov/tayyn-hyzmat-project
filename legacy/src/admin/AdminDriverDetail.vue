<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-slate-800 dark:bg-slate-950">
      <div class="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3 sm:px-6">
        <button type="button" class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-900" @click="$router.back()">
          <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5"><path d="M15 5 8 12l7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-lg font-semibold">{{ driver ? driver.user.fullName : 'Загрузка…' }}</h1>
          <p v-if="driver" class="truncate text-xs text-slate-500">{{ driver.user.phone }}</p>
        </div>
        <DriverStatusBadge v-if="driver" :status="driver.status" :is-online="driver.isOnline" />
        <AdminThemeToggle class="md:hidden" />
      </div>

      <div class="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-4 pb-2 sm:px-6">
        <button
          v-for="t in tabs"
          :key="t.value"
          type="button"
          class="flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-150"
          :class="tab === t.value ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500 hover:text-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-slate-200'"
          @click="tab = t.value"
        >
          {{ t.label }}
        </button>
      </div>
    </header>

    <main v-if="driver" class="mx-auto w-full max-w-3xl flex-1 px-4 py-4 pb-safe-mobile-nav sm:px-6">
      <!-- Инфо -->
      <section v-if="tab === 'info'" class="space-y-3">
        <div class="grid grid-cols-2 gap-2">
          <InfoTile label="Район" :value="driver.district ? driver.district.name : '—'" />
          <InfoTile label="GPS" :value="gpsLabel" />
          <InfoTile label="На связи" :value="lastSeenLabel" />
          <!-- Human-readable device label (@capacitor/device, see auth.service.js#login)
               rather than the opaque deviceId - "видно с какого устройства выполнен вход". -->
          <InfoTile label="Устройство" :value="driver.currentDeviceLabel || (driver.currentDeviceId ? 'Неизвестное устройство' : '—')" />
          <div class="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
            <p class="text-xs text-slate-500">Регистрация</p>
            <p class="text-sm font-medium">{{ formatDate(driver.createdAt) }}</p>
          </div>
        </div>

        <!-- Only admins can change this - drivers see it read-only on their
             own profile (see driver/components/VehicleCard.vue). -->
        <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p class="text-xs text-slate-500">Гос. номер</p>

          <p v-if="!editingVehicle" class="mt-1 flex items-center justify-between gap-2">
            <span class="truncate text-base font-semibold">{{ driver.currentVehicle ? driver.currentVehicle.plateNumber : 'не указан' }}</span>
            <button type="button" class="flex-shrink-0 text-sm font-medium text-indigo-600 dark:text-indigo-400" @click="startEditVehicle">Изменить</button>
          </p>

          <form v-else class="mt-1 flex items-center gap-2" @submit.prevent="submitVehicle">
            <input
              v-model.trim="plateInput"
              type="text"
              placeholder="AG 1234 AA"
              class="w-32 flex-shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
            <button type="submit" :disabled="!plateInput || vehiclePending" class="flex-shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {{ vehiclePending ? '…' : 'Сохранить' }}
            </button>
            <button type="button" class="flex-shrink-0 text-xs text-slate-500" @click="editingVehicle = false">Отмена</button>
          </form>
          <p v-if="vehicleError" class="mt-2 text-xs text-red-600 dark:text-red-400">{{ vehicleError }}</p>
        </div>

        <!-- Single-device login (see backend auth.service.js#login): a
             login from any device other than driver.currentDeviceId is
             rejected and lands here instead, waiting on this. -->
        <div v-if="driver.pendingDeviceId" class="rounded-2xl border border-amber-500 border-opacity-30 bg-amber-500 bg-opacity-10 p-4">
          <p class="text-sm font-semibold text-amber-700 dark:text-amber-400">Запрос на вход с нового устройства</p>
          <p class="mt-1 text-sm font-semibold text-amber-800 dark:text-amber-300">
            {{ driver.pendingDeviceLabel || 'Неизвестное устройство' }}
          </p>
          <p class="mt-1 text-xs text-amber-700 dark:text-amber-400 text-opacity-80">
            Это устройство не входит в список уже одобренных{{ driver.pendingDeviceRequestedAt ? ' · ' + formatDate(driver.pendingDeviceRequestedAt) : '' }}.
            Разрешить вход? Оно запомнится, повторно подтверждать не понадобится.
          </p>
          <div class="mt-3 flex gap-2">
            <button
              type="button"
              class="flex-1 rounded-xl bg-emerald-600 py-2 text-sm font-semibold text-white transition-colors duration-150 hover:bg-emerald-500 disabled:opacity-50"
              :disabled="deviceRequestPending"
              @click="approveDevice"
            >
              Разрешить
            </button>
            <button
              type="button"
              class="flex-1 rounded-xl border border-slate-300 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              :disabled="deviceRequestPending"
              @click="rejectDevice"
            >
              Отклонить
            </button>
          </div>
        </div>

        <!-- Every device this driver has ever been approved on (see
             backend schema.prisma's DriverDevice) - logging in again from
             any of these never needs another approval. -->
        <div v-if="driver.devices && driver.devices.length" class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p class="text-xs font-semibold text-slate-500">Известные устройства</p>
          <div class="mt-2 space-y-1.5">
            <div v-for="d in driver.devices" :key="d.id" class="flex items-center justify-between gap-2 text-sm">
              <span class="min-w-0 truncate" :class="d.deviceId === driver.currentDeviceId ? 'font-semibold text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-300'">
                {{ d.label || 'Неизвестное устройство' }}
                <span v-if="d.deviceId === driver.currentDeviceId" class="ml-1 text-xs font-normal text-emerald-600 dark:text-emerald-400">· текущее</span>
              </span>
              <span class="flex-shrink-0 text-xs text-slate-500">{{ formatDate(d.lastLoginAt) }}</span>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <button
            v-if="driver.status === 'PENDING'"
            type="button"
            class="flex-1 rounded-2xl bg-emerald-600 py-3 text-sm font-semibold text-white transition-colors duration-150 hover:bg-emerald-500"
            @click="approve"
          >
            Одобрить
          </button>
          <button
            v-if="driver.status !== 'BLOCKED'"
            type="button"
            class="flex-1 rounded-2xl border border-red-500 border-opacity-30 py-3 text-sm font-semibold text-red-600 dark:text-red-400 transition-colors duration-150 hover:bg-red-500 hover:bg-opacity-10"
            @click="showBlockForm = !showBlockForm"
          >
            Заблокировать
          </button>
          <button
            v-if="driver.status === 'BLOCKED'"
            type="button"
            class="flex-1 rounded-2xl bg-emerald-600 py-3 text-sm font-semibold text-white transition-colors duration-150 hover:bg-emerald-500"
            @click="unblock"
          >
            Разблокировать
          </button>
        </div>

        <!-- Hard delete, behind a two-step confirm - unlike blocking, this
             can't be undone (see backend admin.service.js#deleteDriver for
             what exactly is removed). -->
        <div class="rounded-2xl border border-red-500 border-opacity-30 p-4">
          <p class="text-sm font-semibold text-red-600 dark:text-red-400">Удалить водителя</p>
          <p class="mt-1 text-xs text-slate-500">
            Безвозвратно удалит аккаунт, баланс, историю баланса, устройства и переписку. Заказы останутся в истории, но
            перестанут быть привязаны к этому водителю. Отменить нельзя — если нужно просто временно закрыть доступ,
            используйте «Заблокировать».
          </p>
          <div v-if="!confirmingDelete" class="mt-3">
            <button
              type="button"
              class="rounded-xl border border-red-500 border-opacity-40 px-4 py-2 text-sm font-semibold text-red-600 transition-colors duration-150 hover:bg-red-500 hover:bg-opacity-10 dark:text-red-400"
              @click="confirmingDelete = true"
            >
              Удалить
            </button>
          </div>
          <div v-else class="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              class="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
              :disabled="deletePending"
              @click="removeDriver"
            >
              {{ deletePending ? 'Удаляем…' : 'Да, удалить навсегда' }}
            </button>
            <button
              type="button"
              class="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
              :disabled="deletePending"
              @click="confirmingDelete = false"
            >
              Отмена
            </button>
          </div>
          <p v-if="deleteError" class="mt-2 text-xs text-red-600 dark:text-red-400">{{ deleteError }}</p>
        </div>

        <transition name="fade">
          <form v-if="showBlockForm" class="flex gap-2" @submit.prevent="block">
            <input
              v-model.trim="blockReason"
              type="text"
              placeholder="Причина блокировки"
              class="flex-1 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-red-500"
            />
            <button type="submit" class="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500">Подтвердить</button>
          </form>
        </transition>
      </section>

      <!-- Баланс -->
      <section v-if="tab === 'balance'" class="space-y-3">
        <div class="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 p-5">
          <div class="flex items-center gap-3">
            <div class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl bg-indigo-500 bg-opacity-10 text-indigo-400">
              <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5">
                <rect x="2.5" y="5.5" width="19" height="13" rx="2.4" stroke="currentColor" stroke-width="1.6" />
                <path d="M2.5 9.5h19" stroke="currentColor" stroke-width="1.6" />
                <circle cx="17.5" cy="14" r="1.3" fill="currentColor" />
              </svg>
            </div>
            <div>
              <p class="text-xs text-slate-500">Текущий баланс</p>
              <p class="text-2xl font-bold tabular-nums">{{ formattedBalance }} <span class="text-sm font-semibold text-slate-500">TMT</span></p>
            </div>
          </div>
        </div>

        <form class="flex items-center gap-2" @submit.prevent="submitBalance">
          <input
            v-model.number="balanceAmount"
            type="number"
            min="0"
            step="0.01"
            placeholder="Сумма"
            class="flex-1 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 px-3 py-2.5 text-sm text-slate-900 dark:text-slate-100 outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-indigo-500"
          />
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-indigo-500 disabled:opacity-50"
            :disabled="!balanceAmount || balancePending"
            @click="submitBalance('topup')"
          >
            + Пополнить
          </button>
          <button
            type="button"
            class="rounded-xl border border-red-500 border-opacity-30 px-4 py-2.5 text-sm font-semibold text-red-600 dark:text-red-400 transition-colors duration-150 hover:bg-red-500 hover:bg-opacity-10 disabled:opacity-50"
            :disabled="!balanceAmount || balancePending"
            @click="submitBalance('withdraw')"
          >
            − Списать
          </button>
        </form>
        <p v-if="balanceError" class="text-xs text-red-600 dark:text-red-400">{{ balanceError }}</p>

        <div>
          <p class="mb-2 text-xs font-semibold text-slate-500">Последние транзакции</p>
          <div v-if="!transactions.length" class="py-6 text-center text-sm text-slate-500">Пока нет транзакций</div>
          <div class="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800">
            <div v-for="tx in transactions" :key="tx.id" class="flex items-center justify-between border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 px-3 py-2.5 text-sm last:border-0">
              <div>
                <p class="font-medium">{{ transactionTypeLabel(tx.type) }}</p>
                <p class="text-xs text-slate-500">{{ formatDate(tx.createdAt) }}</p>
              </div>
              <p class="font-semibold tabular-nums" :class="Number(tx.amount) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'">
                {{ Number(tx.amount) >= 0 ? '+' : '' }}{{ tx.amount }}
              </p>
            </div>
          </div>
        </div>
      </section>

      <!-- История заказов -->
      <section v-if="tab === 'history'" class="space-y-2">
        <div v-if="!orders.length" class="py-10 text-center text-sm text-slate-500">Заказов пока нет</div>
        <div v-for="order in orders" :key="order.id" class="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 p-3">
          <div class="flex items-center justify-between">
            <OrderStatusBadge :status="order.status" />
            <p class="text-sm font-semibold tabular-nums">{{ order.priceFinal || order.priceEstimated || 0 }} TMT</p>
          </div>
          <p class="mt-1 truncate text-xs text-slate-500">{{ order.pickupAddress || '—' }} → {{ order.dropoffAddress || '—' }}</p>
          <p class="text-xs text-slate-500">{{ formatDate(order.createdAt) }}</p>
        </div>
      </section>

      <!-- Чат -->
      <section v-if="tab === 'chat'" style="height: calc(100vh - 220px);">
        <AdminChatThread :driver-id="driverId" />
      </section>
    </main>

    <div v-else class="flex min-h-screen items-center justify-center text-sm text-slate-500">Загрузка…</div>

    <AdminNav />
  </div>
</template>

<script>
import DriverStatusBadge from './components/DriverStatusBadge.vue'
import OrderStatusBadge from './components/OrderStatusBadge.vue'
import AdminChatThread from './components/AdminChatThread.vue'
import AdminNav from './components/AdminNav.vue'
import AdminThemeToggle from './components/AdminThemeToggle.vue'
import InfoTile from './components/InfoTile.vue'
import { reverseGeocode } from '@/services/geocoding'
import adminApiClient from '@/services/adminApiClient'

const TRANSACTION_TYPE_LABELS = {
  TOPUP: 'Пополнение',
  EARNING: 'Начисление',
  COMMISSION: 'Комиссия',
  PAYMENT: 'Оплата поездки',
  WITHDRAWAL: 'Списание',
  REFUND: 'Возврат',
  BONUS: 'Бонус',
  ADJUSTMENT: 'Корректировка'
}

export default {
  name: 'AdminDriverDetail',
  components: { DriverStatusBadge, OrderStatusBadge, AdminChatThread, AdminNav, AdminThemeToggle, InfoTile },
  props: {
    driverId: { type: String, required: true }
  },
  data() {
    return {
      tab: 'info',
      showBlockForm: false,
      blockReason: '',
      deviceRequestPending: false,
      balanceAmount: null,
      balancePending: false,
      balanceError: '',
      editingVehicle: false,
      plateInput: '',
      vehiclePending: false,
      vehicleError: '',
      gpsAddress: '',
      geocodingGps: false,
      lastGeocodedPos: null,
      confirmingDelete: false,
      deletePending: false,
      deleteError: ''
    }
  },
  computed: {
    tabs() {
      return [
        { value: 'info', label: 'Инфо' },
        { value: 'balance', label: 'Баланс' },
        { value: 'history', label: 'История' },
        { value: 'chat', label: 'Чат' }
      ]
    },
    driver() {
      return this.$store.state.adminDrivers.current
    },
    history() {
      return this.$store.state.adminDrivers.currentHistory
    },
    transactions() {
      return this.history ? this.history.transactions.items : []
    },
    orders() {
      return this.history ? this.history.orders.items : []
    },
    formattedBalance() {
      const amount = this.driver && this.driver.user.balance ? Number(this.driver.user.balance.amount) : 0
      return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount)
    },
    gpsLabel() {
      if (!this.driver || this.driver.lastLat == null) return 'нет данных'
      if (this.gpsAddress) return this.gpsAddress
      return `${Number(this.driver.lastLat).toFixed(4)}, ${Number(this.driver.lastLng).toFixed(4)}`
    },
    lastSeenLabel() {
      if (!this.driver || !this.driver.lastLocationAt) return 'никогда'
      return this.formatDate(this.driver.lastLocationAt)
    }
  },
  watch: {
    driverId: {
      immediate: true,
      handler() {
        this.load()
      }
    },
    'driver.lastLat'() {
      this.maybeGeocodeGps()
    }
  },
  methods: {
    async load() {
      this.gpsAddress = ''
      this.lastGeocodedPos = null
      await Promise.all([
        this.$store.dispatch('adminDrivers/fetchDetail', this.driverId),
        this.$store.dispatch('adminDrivers/fetchHistory', this.driverId)
      ])
      this.maybeGeocodeGps()
    },
    // Same reverse-geocoding as driver/components/GpsInfoCard.vue - only
    // re-runs when the point actually moved (no live GPS stream feeding
    // this page, just whatever fetchDetail last loaded, so no aggressive
    // throttling needed here).
    async maybeGeocodeGps() {
      if (!this.driver || this.driver.lastLat == null || this.geocodingGps) return
      const pos = { lat: Number(this.driver.lastLat), lng: Number(this.driver.lastLng) }
      if (this.lastGeocodedPos && this.lastGeocodedPos.lat === pos.lat && this.lastGeocodedPos.lng === pos.lng) return
      this.geocodingGps = true
      this.lastGeocodedPos = pos
      try {
        const line = await reverseGeocode(pos.lat, pos.lng, adminApiClient)
        if (line) this.gpsAddress = line
      } catch (err) {
        // Silent - the raw-coordinates fallback in gpsLabel already covers this.
      } finally {
        this.geocodingGps = false
      }
    },
    transactionTypeLabel(type) {
      return TRANSACTION_TYPE_LABELS[type] || type
    },
    formatDate(value) {
      return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    },
    async approve() {
      await this.$store.dispatch('adminDrivers/approve', this.driverId)
    },
    async block() {
      await this.$store.dispatch('adminDrivers/block', { driverId: this.driverId, reason: this.blockReason })
      this.showBlockForm = false
      this.blockReason = ''
    },
    async unblock() {
      await this.$store.dispatch('adminDrivers/unblock', this.driverId)
    },
    // Irreversible - back to the list afterwards, since this page's own
    // driver no longer exists to render.
    async removeDriver() {
      this.deletePending = true
      this.deleteError = ''
      try {
        await this.$store.dispatch('adminDrivers/remove', this.driverId)
        this.$store.dispatch('ui/pushToast', { title: 'Водитель удалён', variant: 'success' })
        this.$router.replace('/adminDrivers')
      } catch (err) {
        this.deleteError = (err.response && err.response.data && err.response.data.message) || 'Не удалось удалить водителя'
        this.deletePending = false
      }
    },
    async approveDevice() {
      this.deviceRequestPending = true
      try {
        await this.$store.dispatch('adminDrivers/approveDevice', this.driverId)
      } finally {
        this.deviceRequestPending = false
      }
    },
    async rejectDevice() {
      this.deviceRequestPending = true
      try {
        await this.$store.dispatch('adminDrivers/rejectDevice', this.driverId)
      } finally {
        this.deviceRequestPending = false
      }
    },
    startEditVehicle() {
      this.editingVehicle = true
      this.plateInput = this.driver.currentVehicle ? this.driver.currentVehicle.plateNumber : ''
      this.vehicleError = ''
    },
    async submitVehicle() {
      if (!this.plateInput) return
      this.vehiclePending = true
      this.vehicleError = ''
      try {
        await this.$store.dispatch('adminDrivers/updateVehicle', { driverId: this.driverId, plateNumber: this.plateInput })
        this.editingVehicle = false
      } catch (err) {
        this.vehicleError = (err.response && err.response.data && err.response.data.message) || 'Не удалось сохранить номер'
      } finally {
        this.vehiclePending = false
      }
    },
    async submitBalance(kind) {
      if (!this.balanceAmount) return
      this.balancePending = true
      this.balanceError = ''
      try {
        await this.$store.dispatch('adminDrivers/adjustBalance', { driverId: this.driverId, amount: this.balanceAmount, kind })
        await this.$store.dispatch('adminDrivers/fetchHistory', this.driverId)
        this.balanceAmount = null
      } catch (err) {
        this.balanceError = (err.response && err.response.data && err.response.data.message) || 'Не удалось изменить баланс'
      } finally {
        this.balancePending = false
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
