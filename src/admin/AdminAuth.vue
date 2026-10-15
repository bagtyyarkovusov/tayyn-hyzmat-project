<template>
  <div class="driver-app flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-50 to-slate-50 px-4 py-10 text-slate-900 transition-colors duration-300 dark:from-slate-900 dark:to-slate-900 dark:text-slate-100">
    <div class="w-full max-w-sm animate-scale-in">
      <div class="mb-6 text-center">
        <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-900 text-white shadow-lg dark:bg-indigo-600">
          <svg viewBox="0 0 24 24" fill="none" class="h-7 w-7">
            <path d="M12 3 4 6.5v5c0 5 3.4 8.5 8 9.5 4.6-1 8-4.5 8-9.5v-5L12 3Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
            <path d="m9 12 2.2 2.2L15.5 10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <h1 class="mt-3 text-xl font-bold">Tayyn hyzmat</h1>
        <p class="text-sm text-slate-500 dark:text-slate-400">Панель управления</p>
      </div>

      <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <transition name="banner">
          <div
            v-if="logoutMessage"
            class="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-500 dark:bg-opacity-10 dark:text-amber-400"
          >
            {{ logoutMessage }}
          </div>
        </transition>

        <form class="space-y-4" @submit.prevent="submit">
          <div>
            <label class="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Номер телефона</label>
            <input
              v-model.trim="phone"
              type="tel"
              required
              placeholder="+993 XX XXX XXX"
              class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition-colors duration-200 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:bg-slate-900"
            />
          </div>

          <div>
            <label class="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Пароль</label>
            <input
              v-model="password"
              type="password"
              required
              placeholder="••••••••"
              class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition-colors duration-200 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:bg-slate-900"
            />
          </div>

          <transition name="banner">
            <div v-if="errorMessage" class="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500 dark:bg-opacity-10 dark:text-red-400">
              {{ errorMessage }}
            </div>
          </transition>

          <button
            type="submit"
            class="flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition-all duration-200 hover:bg-slate-800 active:scale-95 disabled:opacity-60 dark:bg-indigo-600 dark:hover:bg-indigo-500"
            :disabled="submitting"
          >
            <svg v-if="submitting" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
            </svg>
            {{ submitting ? 'Подождите…' : 'Войти' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'AdminAuth',
  data() {
    return {
      phone: '',
      password: '',
      submitting: false,
      localError: ''
    }
  },
  computed: {
    errorMessage() {
      return this.localError
    },
    logoutMessage() {
      return this.$store.state.adminAuth.logoutMessage
    }
  },
  methods: {
    async submit() {
      this.submitting = true
      this.localError = ''
      this.$store.commit('adminAuth/CLEAR_LOGOUT_MESSAGE')
      try {
        await this.$store.dispatch('adminAuth/login', { phone: this.phone, password: this.password })
        this.$router.replace('/adminDashboard')
      } catch (err) {
        this.localError = (err.response && err.response.data && err.response.data.message) || 'Не удалось войти'
      } finally {
        this.submitting = false
      }
    }
  }
}
</script>

<style scoped>
.banner-enter-active,
.banner-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.banner-enter,
.banner-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
