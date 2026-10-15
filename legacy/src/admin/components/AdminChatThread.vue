<template>
  <div class="flex h-full flex-col">
    <div ref="scrollArea" class="flex-1 space-y-2 overflow-y-auto px-1 py-2">
      <p v-if="!messages.length" class="py-10 text-center text-sm text-slate-500">Сообщений пока нет</p>

      <div v-for="message in messages" :key="message.id" class="flex" :class="isFromDriver(message) ? 'justify-start' : 'justify-end'">
        <div
          class="rounded-2xl px-3 py-2 text-sm"
          style="max-width: 75%;"
          :class="isFromDriver(message) ? 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100' : 'bg-indigo-600 text-white'"
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
        placeholder="Написать водителю…"
        class="flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none transition-colors duration-200 placeholder:text-slate-400 focus:border-indigo-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500"
      />
      <button
        type="submit"
        class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white transition-colors duration-150 hover:bg-indigo-500 disabled:opacity-50"
        :disabled="!draft || sending"
      >
        <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4">
          <path d="M4.5 12 19.5 5l-5 15-3-6-7-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
        </svg>
      </button>
    </form>
  </div>
</template>

<script>
export default {
  name: 'AdminChatThread',
  props: {
    driverId: { type: String, required: true }
  },
  data() {
    return {
      draft: '',
      sending: false
    }
  },
  computed: {
    messages() {
      return this.$store.state.adminDrivers.currentMessages
    },
    current() {
      return this.$store.state.adminDrivers.current
    }
  },
  watch: {
    driverId: {
      immediate: true,
      handler() {
        this.load()
      }
    },
    messages() {
      this.$nextTick(this.scrollToBottom)
    }
  },
  methods: {
    async load() {
      if (!this.current || this.current.id !== this.driverId) {
        await this.$store.dispatch('adminDrivers/fetchDetail', this.driverId)
      }
      await this.$store.dispatch('adminDrivers/fetchMessages', this.driverId)
      this.$nextTick(this.scrollToBottom)
    },
    isFromDriver(message) {
      return Boolean(this.current) && message.senderId === this.current.user.id
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
        await this.$store.dispatch('adminDrivers/sendMessage', { driverId: this.driverId, body })
      } finally {
        this.sending = false
      }
    }
  }
}
</script>
