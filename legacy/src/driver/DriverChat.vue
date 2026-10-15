<template>
  <div class="flex min-h-screen flex-col bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-ink-950 dark:text-slate-100 md:pl-60">
    <header class="sticky top-0 z-20 border-b border-slate-200 bg-slate-50 bg-opacity-90 backdrop-blur transition-colors duration-300 dark:border-ink-600 dark:bg-ink-950">
      <div class="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3 sm:px-6">
        <button
          type="button"
          class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-800"
          @click="$router.back()"
        >
          <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5">
            <path d="M15 5 8 12l7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <div>
          <p class="text-lg font-semibold text-slate-900 dark:text-white">Администрация</p>
          <p class="text-xs text-slate-500">Поддержка Tayyn hyzmat</p>
        </div>
      </div>
    </header>

    <main class="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-3 sm:px-6" style="height: calc(100vh - 76px);">
      <div ref="scrollArea" class="flex-1 space-y-2 overflow-y-auto py-2">
        <div v-if="loading && !messages.length" class="space-y-2">
          <div v-for="n in 4" :key="n" class="h-12 w-2/3 animate-pulse rounded-2xl bg-slate-100 dark:bg-ink-800" />
        </div>

        <p v-else-if="!messages.length" class="py-10 text-center text-sm text-slate-500">Напишите администрации, если нужна помощь</p>

        <div v-for="message in messages" :key="message.id" class="flex" :class="isFromAdmin(message) ? 'justify-start' : 'justify-end'">
          <div
            class="rounded-2xl px-3 py-2 text-sm"
            style="max-width: 80%;"
            :class="isFromAdmin(message) ? 'bg-white text-slate-900 dark:bg-ink-800 dark:text-slate-100' : 'bg-brand-600 text-white'"
          >
            <p class="whitespace-pre-wrap break-words">{{ message.body }}</p>
            <p class="mt-0.5 text-right text-xs opacity-70">{{ formatTime(message.sentAt) }}</p>
          </div>
        </div>
      </div>

      <form class="mt-2 flex items-center gap-2" @submit.prevent="send">
        <input
          v-model.trim="draft"
          type="text"
          placeholder="Сообщение…"
          class="flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none transition-colors duration-200 placeholder:text-slate-400 focus:border-brand-500 dark:border-ink-600 dark:bg-ink-800 dark:text-slate-100 dark:placeholder:text-slate-500"
        />
        <button
          type="submit"
          class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition-colors duration-150 hover:bg-brand-500 disabled:opacity-50"
          :disabled="!draft || sending"
        >
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4">
            <path d="M4.5 12 19.5 5l-5 15-3-6-7-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          </svg>
        </button>
      </form>
    </main>
  </div>
</template>

<script>
export default {
  name: 'DriverChat',
  data() {
    return {
      draft: '',
      sending: false
    }
  },
  computed: {
    messages() {
      return this.$store.state.driverChat.messages
    },
    loading() {
      return this.$store.state.driverChat.loading
    },
    myUserId() {
      const user = this.$store.state.driverAuth.user
      return user ? user.id : null
    }
  },
  watch: {
    messages() {
      this.$nextTick(this.scrollToBottom)
    }
  },
  mounted() {
    // Loads history and zeroes the unread badge (see store/modules/driverChat.js) -
    // "уведомления о новых сообщениях" means the badge stays until this screen is opened.
    this.$store.dispatch('driverChat/markOpen').then(() => this.$nextTick(this.scrollToBottom))
  },
  beforeDestroy() {
    this.$store.dispatch('driverChat/markClosed')
  },
  methods: {
    isFromAdmin(message) {
      return message.senderId !== this.myUserId
    },
    formatTime(sentAt) {
      return new Date(sentAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    },
    scrollToBottom() {
      const el = this.$refs.scrollArea
      if (el) el.scrollTop = el.scrollHeight
    },
    async send() {
      if (!this.draft || this.sending) return
      this.sending = true
      const body = this.draft
      this.draft = ''
      try {
        await this.$store.dispatch('driverChat/sendMessage', body)
      } finally {
        this.sending = false
      }
    }
  }
}
</script>
