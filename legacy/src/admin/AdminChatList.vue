<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-slate-800 dark:bg-slate-950">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
        <div>
          <h1 class="text-lg font-semibold">Чат</h1>
          <p class="text-xs text-slate-500">Выберите водителя, чтобы написать или продолжить переписку</p>
        </div>
        <AdminThemeToggle class="md:hidden" />
      </div>
    </header>

    <main class="mx-auto max-w-5xl space-y-4 px-4 py-4 pb-safe-mobile-nav sm:px-6">
      <!-- POST /admin/messages with broadcast: true was already fully
           built on the backend (see admin.service.js#sendMessage) and
           already consumed on the driver side (driverAuth.js's
           onAdminMessage handler, shown as a toast + saved into the
           driver's own chat history) - this was just missing a UI to
           actually compose one. -->
      <section class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <p class="text-sm font-semibold">Сообщение всем водителям</p>
        <p class="mt-0.5 text-xs text-slate-500">Уйдёт сразу всем одобренным водителям одним сообщением, а не по отдельности</p>
        <form class="mt-3 flex items-end gap-2" @submit.prevent="sendBroadcast">
          <textarea
            v-model.trim="broadcastDraft"
            rows="2"
            placeholder="Например: сегодня в центре перекрыты дороги, будьте внимательны"
            class="flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500"
          />
          <button
            type="submit"
            class="flex-shrink-0 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-indigo-500 disabled:opacity-50"
            :disabled="!broadcastDraft || broadcastSending"
          >
            {{ broadcastSending ? 'Отправка…' : 'Отправить всем' }}
          </button>
        </form>
      </section>

      <div>
        <h2 class="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">Личные переписки</h2>
        <div v-if="loading && !items.length" class="space-y-2">
          <div v-for="n in 5" :key="n" class="h-20 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-900" />
        </div>

        <p v-else-if="!items.length" class="py-10 text-center text-sm text-slate-500">Нет одобренных водителей</p>

        <div class="grid gap-2 sm:grid-cols-2">
          <DriverListItem
            v-for="driver in items"
            :key="driver.id"
            :driver="driver"
            :to="`/adminChat/${driver.id}`"
            :show-balance="false"
          >
            <!-- driver.hasUnreadMessage is what this list's own fetch
                 returned; isDriverUnread also catches a message that
                 arrived live (socket) since that fetch - see
                 store/modules/adminDrivers.js#applyIncomingMessage. -->
            <span v-if="driver.hasUnreadMessage || isDriverUnread(driver.id)" class="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-red-500" />
          </DriverListItem>
        </div>
      </div>
    </main>

    <AdminNav />
  </div>
</template>

<script>
import adminApiClient from '@/services/adminApiClient'
import DriverListItem from './components/DriverListItem.vue'
import AdminNav from './components/AdminNav.vue'
import AdminThemeToggle from './components/AdminThemeToggle.vue'

export default {
  name: 'AdminChatList',
  components: { DriverListItem, AdminNav, AdminThemeToggle },
  data() {
    return { items: [], loading: false, broadcastDraft: '', broadcastSending: false }
  },
  mounted() {
    this.load()
  },
  methods: {
    isDriverUnread(driverId) {
      return this.$store.getters['adminDrivers/isDriverUnread'](driverId)
    },
    async sendBroadcast() {
      if (!this.broadcastDraft || this.broadcastSending) return
      this.broadcastSending = true
      const body = this.broadcastDraft
      try {
        await adminApiClient.post('/admin/messages', { broadcast: true, body })
        this.broadcastDraft = ''
        this.$store.dispatch('ui/pushToast', { title: 'Отправлено', body: 'Сообщение ушло всем водителям', variant: 'success' })
      } catch (err) {
        const message = (err.response && err.response.data && err.response.data.message) || 'Не удалось отправить сообщение'
        this.$store.dispatch('ui/pushToast', { title: 'Ошибка', body: message, variant: 'error' })
      } finally {
        this.broadcastSending = false
      }
    },
    async load() {
      // Deliberately a local fetch, not the shared `adminDrivers` list
      // module: that one is the filterable Водители-tab state (PENDING /
      // APPROVED / BLOCKED), and reusing it here would mean switching to
      // this tab silently overwrites whatever the Водители tab had loaded.
      this.loading = true
      try {
        const { data } = await adminApiClient.get('/admin/drivers', { params: { status: 'APPROVED', limit: 100 } })
        this.items = data.items
      } finally {
        this.loading = false
      }
    }
  }
}
</script>
