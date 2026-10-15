<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-ink-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-20 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-ink-600 dark:bg-ink-950">
      <div class="mx-auto flex max-w-3xl flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
        <StatusPill :state="gpsState" label="GPS" clickable @click="onGpsIconClick" />
        <StatusPill :state="networkState" label="Internet" />
        <OnlineToggle />

        <span
          class="ml-auto flex flex-shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-semibold transition-colors duration-300"
          :class="isBalanceEmpty ? 'border-amber-500 border-opacity-30 bg-amber-500 bg-opacity-10 text-amber-700 dark:text-amber-400' : 'border-brand-500 border-opacity-30 bg-brand-500 bg-opacity-10 text-brand-700 dark:text-brand-400'"
          :title="isBalanceEmpty ? 'Пополните, чтобы получать заказы' : 'Баланс'"
        >
          <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5 flex-shrink-0">
            <rect x="2.5" y="5.5" width="19" height="13" rx="2.4" stroke="currentColor" stroke-width="1.8" />
            <path d="M2.5 9.5h19" stroke="currentColor" stroke-width="1.8" />
            <circle cx="17.5" cy="14" r="1.3" fill="currentColor" />
          </svg>
          {{ formattedBalance }} {{ balanceCurrency }}
        </span>
      </div>
    </header>

    <main class="mx-auto max-w-3xl space-y-3 px-4 py-4 pb-safe-mobile-nav-lg sm:px-6">
      <transition name="fade">
        <div
          v-if="!isOnline"
          class="flex items-center gap-2 rounded-2xl border border-red-500 border-opacity-30 bg-red-500 bg-opacity-10 px-4 py-3 text-sm text-red-700 dark:text-red-400"
        >
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4 flex-shrink-0">
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" />
            <path d="M12 8v5M12 15.5h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
          <div>
            <p class="font-semibold">Нет подключения</p>
            <p class="text-red-700 text-opacity-80 dark:text-red-400">Проверьте интернет — заказы не показываются и не принимаются. Координаты сохраняются локально.</p>
          </div>
        </div>
      </transition>

      <template v-if="isOnDuty">
        <!-- The district grid used to be hidden entirely until GPS produced
             a fix ("Ожидаем сигнал GPS"), which left drivers stuck on an
             empty screen every time a first lock was slow. That gate only
             made sense while a driver could ONLY take orders from their own
             GPS-derived district - now that any district's orders can be
             accepted (see backend orders.service.js#accept), waiting on GPS
             buys nothing, so the grid is always shown and a missing fix is
             just a non-blocking warning above it. -->
        <div
          v-if="gpsOn !== true"
          class="flex items-center gap-2 rounded-2xl border border-amber-500 border-opacity-30 bg-amber-500 bg-opacity-10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400"
        >
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4 flex-shrink-0">
            <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            <circle cx="12" cy="9.5" r="2.2" stroke="currentColor" stroke-width="1.8" />
          </svg>
          <div>
            <p class="font-semibold">Ищем сигнал GPS</p>
            <p class="text-amber-700 text-opacity-80 dark:text-amber-400">Заказы можно принимать и сейчас. Если значок GPS долго не зеленеет — проверьте, включена ли геолокация.</p>
          </div>
        </div>
        <DistrictGrid />
      </template>
      <div v-else class="flex flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center dark:border-ink-600 dark:bg-ink-800">
        <div class="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-ink-900 dark:text-slate-500">
          <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5">
            <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            <path d="m5 5 14 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </div>
        <p class="text-sm font-semibold text-slate-700 dark:text-slate-200">Вы не на линии</p>
        <p class="max-w-xs text-xs text-slate-500">Районы и заказы скрыты, пока вы офлайн. Нажмите «Online» вверху, чтобы начать принимать заказы.</p>
      </div>

      <GpsInfoCard :state="gpsState" :position="latestPosition" />
    </main>

    <BottomNav />

    <OrderOverlay />

    <GpsRequiredModal v-if="showGpsRequiredModal" :enabling="enablingGps" :show-hint="gpsHint" @enable="handleEnableGps" @logout="logout" />
  </div>
</template>

<script>
import StatusPill from './components/StatusPill.vue'
import DistrictGrid from './components/DistrictGrid.vue'
import GpsInfoCard from './components/GpsInfoCard.vue'
import GpsRequiredModal from './components/GpsRequiredModal.vue'
import BottomNav from './components/BottomNav.vue'
import OrderOverlay from './components/OrderOverlay.vue'
import OnlineToggle from './components/OnlineToggle.vue'
import locationReporter from './mixins/locationReporter'

export default {
  name: 'DriverHome',
  components: { StatusPill, DistrictGrid, GpsInfoCard, GpsRequiredModal, BottomNav, OrderOverlay, OnlineToggle },
  mixins: [locationReporter],
  computed: {
    balanceAmount() {
      return this.$store.getters['driverAuth/balanceAmount']
    },
    balanceCurrency() {
      return this.$store.getters['driverAuth/balanceCurrency']
    },
    isBalanceEmpty() {
      return this.balanceAmount <= 0
    },
    formattedBalance() {
      return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(this.balanceAmount)
    },
    adminMessage() {
      return this.$store.state.driverAuth.lastAdminMessage
    },
    // Named isOnDuty (not isOnline) to avoid colliding with
    // locationReporter.js's own `isOnline` (navigator.onLine network
    // connectivity) - this is the driver's own OnlineToggle.vue state
    // instead, "ready to work". Backend enforces the actual order-delivery
    // side of this (see backend driver.service.js#setStatus /
    // sockets/index.js) - hiding the grid here just matches what an
    // offline driver can now actually receive.
    isOnDuty() {
      const driver = this.$store.state.driverAuth.driver
      return Boolean(driver && driver.isOnline)
    }
  },
  watch: {
    adminMessage(message) {
      if (!message) return
      this.$store.dispatch('ui/pushToast', { title: message.title, body: message.body })
    }
  },
  mounted() {
    this.$store.dispatch('driverAuth/fetchBalance').catch(() => {})
  },
  methods: {
    logout() {
      this.$store.dispatch('driverAuth/logout')
      this.$router.replace('/driverLogin')
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
