<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-ink-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-20 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-ink-600 dark:bg-ink-950">
      <div class="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
        <h1 class="text-lg font-semibold">Профиль</h1>
        <DriverThemeToggle class="md:hidden" />
      </div>
    </header>

    <main class="mx-auto max-w-3xl space-y-4 px-4 py-5 pb-safe-mobile-nav-lg sm:px-6">
      <!-- In-app update ("такая функция есть у ЮMoney") - only ever shown
           when /apk/latest.json (see services/appVersion.js) actually
           describes something newer than this running build. -->
      <div v-if="updateInfo" class="rounded-2xl border border-brand-500 border-opacity-30 bg-brand-500 bg-opacity-10 p-4">
        <p class="text-sm font-semibold text-brand-700 dark:text-brand-400">Доступна новая версия {{ updateInfo.versionName }}</p>
        <p v-if="updateInfo.notes" class="mt-1 text-xs text-slate-600 dark:text-slate-300">{{ updateInfo.notes }}</p>
        <a
          :href="updateInfo.url"
          class="mt-3 block rounded-xl bg-brand-600 py-2.5 text-center text-sm font-semibold text-white transition-colors duration-150 hover:bg-brand-500"
        >
          Скачать и установить
        </a>
        <p class="mt-2 text-center text-xs text-slate-500">После загрузки откройте файл, чтобы установить — телефон может попросить разрешить установку из этого источника</p>
      </div>

      <div class="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-ink-600 dark:bg-ink-800">
        <div class="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-lg font-semibold text-white">
          {{ initials }}
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-base font-semibold text-slate-900 dark:text-white">{{ fullName || 'Водитель' }}</p>
          <p class="truncate text-sm text-slate-500">{{ phone }}</p>
        </div>
        <span class="flex flex-shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold" :class="statusMeta.class">
          <span class="h-1.5 w-1.5 rounded-full" :class="statusMeta.dot" />
          {{ statusMeta.label }}
        </span>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <InfoTile label="Имя" :value="fullName || '—'" />
        <InfoTile label="Телефон" :value="phone || '—'" />
      </div>

      <VehicleCard />

      <BalanceCard :amount="balanceAmount" :currency="balanceCurrency" />

      <HistoryCard />

      <router-link
        to="/driverChat"
        class="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 transition-colors duration-150 hover:border-brand-500 hover:border-opacity-50 dark:border-ink-600 dark:bg-ink-800"
      >
        <div class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-500 bg-opacity-10 text-brand-600 dark:text-brand-400">
          <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5">
            <path
              d="M4.5 6.5A2 2 0 0 1 6.5 4.5h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3.5V16.5H6.5a2 2 0 0 1-2-2v-8Z"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linejoin="round"
            />
          </svg>
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-slate-900 dark:text-slate-100">Поддержка</p>
          <p class="truncate text-xs text-slate-500">Напишите администрации, если нужна помощь</p>
        </div>
        <span
          v-if="unreadCount"
          class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-semibold text-white"
        >
          {{ unreadCount }}
        </span>
        <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5 flex-shrink-0 text-slate-400 dark:text-slate-600">
          <path d="m9 5 7 7-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </router-link>

      <button
        type="button"
        class="w-full rounded-2xl border border-red-500 border-opacity-30 py-3 text-sm font-semibold text-red-600 transition-colors duration-150 hover:bg-red-500 hover:bg-opacity-10 dark:text-red-400"
        @click="logout"
      >
        Выйти
      </button>
    </main>

    <BottomNav />
  </div>
</template>

<script>
import BalanceCard from './components/BalanceCard.vue'
import VehicleCard from './components/VehicleCard.vue'
import BottomNav from './components/BottomNav.vue'
import InfoTile from './components/InfoTile.vue'
import HistoryCard from './components/HistoryCard.vue'
import DriverThemeToggle from './components/DriverThemeToggle.vue'
import { checkForUpdate } from '@/services/appVersion'

const DRIVER_STATUS_META = {
  APPROVED: { label: 'Approved', class: 'bg-brand-500 bg-opacity-10 text-brand-600 dark:text-brand-400', dot: 'bg-brand-500' },
  PENDING: { label: 'На проверке', class: 'bg-amber-500 bg-opacity-10 text-amber-700 dark:text-amber-400', dot: 'bg-amber-500' },
  BLOCKED: { label: 'Заблокирован', class: 'bg-red-500 bg-opacity-10 text-red-700 dark:text-red-400', dot: 'bg-red-500' }
}

export default {
  name: 'DriverProfile',
  components: { BalanceCard, VehicleCard, BottomNav, InfoTile, DriverThemeToggle, HistoryCard },
  data() {
    return {
      updateInfo: null // { versionCode, versionName, url, notes } or null
    }
  },
  computed: {
    fullName() {
      return this.$store.getters['driverAuth/driverName']
    },
    phone() {
      const user = this.$store.state.driverAuth.user
      return user ? user.phone : ''
    },
    balanceAmount() {
      return this.$store.getters['driverAuth/balanceAmount']
    },
    balanceCurrency() {
      return this.$store.getters['driverAuth/balanceCurrency']
    },
    unreadCount() {
      return this.$store.state.driverChat.unreadCount
    },
    statusMeta() {
      const driver = this.$store.state.driverAuth.driver
      const status = driver ? driver.status : ''
      return DRIVER_STATUS_META[status] || { label: status || '—', class: 'bg-slate-100 text-slate-500 dark:bg-ink-700 dark:text-slate-400', dot: 'bg-slate-500' }
    },
    initials() {
      return (this.fullName || '?')
        .split(' ')
        .map((part) => part[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    }
  },
  mounted() {
    this.$store.dispatch('driverAuth/fetchBalance').catch(() => {})
    this.$store.dispatch('driverAuth/fetchProfile').catch(() => {})
    checkForUpdate().then((info) => {
      this.updateInfo = info
    })
  },
  methods: {
    logout() {
      this.$store.dispatch('driverAuth/logout')
      this.$router.replace('/driverLogin')
    }
  }
}
</script>
