<template>
  <div class="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 text-slate-900 transition-colors duration-300 dark:bg-ink-950 dark:text-slate-100">
    <div class="w-full max-w-sm animate-scale-in">
      <div class="mb-6 text-center">
        <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-lg shadow-brand-600/20">
          <svg viewBox="0 0 24 24" fill="none" class="h-7 w-7">
            <path d="M4 16.5 6 9a3 3 0 0 1 2.9-2.2h6.2A3 3 0 0 1 18 9l2 7.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
            <rect x="3" y="16.5" width="18" height="4" rx="1.6" stroke="currentColor" stroke-width="1.7" />
            <circle cx="7.5" cy="14" r="1.1" fill="currentColor" />
            <circle cx="16.5" cy="14" r="1.1" fill="currentColor" />
          </svg>
        </div>
        <h1 class="mt-3 text-xl font-bold text-slate-900 dark:text-white">Tayyn hyzmat Водитель</h1>
        <p class="text-sm text-slate-500">Панель для работы с заказами</p>
      </div>

      <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl transition-colors duration-300 dark:border-ink-600 dark:bg-ink-800">
        <div class="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 transition-colors duration-300 dark:bg-ink-900">
          <button
            type="button"
            class="rounded-lg py-2 text-sm font-medium transition-all duration-200"
            :class="mode === 'login' ? 'bg-white text-slate-900 shadow dark:bg-ink-700 dark:text-white' : 'text-slate-500'"
            @click="switchMode('login')"
          >
            Вход
          </button>
          <button
            type="button"
            class="rounded-lg py-2 text-sm font-medium transition-all duration-200"
            :class="mode === 'register' ? 'bg-white text-slate-900 shadow dark:bg-ink-700 dark:text-white' : 'text-slate-500'"
            @click="switchMode('register')"
          >
            Регистрация
          </button>
        </div>

        <transition name="banner">
          <div v-if="logoutMessage" class="mb-4 rounded-xl bg-amber-500 bg-opacity-10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            {{ logoutMessage }}
          </div>
        </transition>

        <transition name="banner" mode="out-in">
          <div v-if="registerSuccess" key="success" class="space-y-4 text-center">
            <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-500 bg-opacity-10 text-brand-600 dark:text-brand-400">
              <svg viewBox="0 0 24 24" fill="none" class="h-6 w-6">
                <path d="m6 12 4 4 8-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
            <p class="text-sm text-slate-600 dark:text-slate-300">{{ registerSuccess }}</p>
            <button
              type="button"
              class="w-full rounded-2xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition-all duration-200 hover:bg-brand-500 active:scale-95"
              @click="switchMode('login')"
            >
              Перейти ко входу
            </button>
          </div>

          <form v-else key="form" class="space-y-4" @submit.prevent="submit">
            <div v-if="mode === 'register'">
              <label class="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Имя</label>
              <input
                v-model.trim="fullName"
                type="text"
                required
                placeholder="Иван Иванов"
                class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition-colors duration-200 placeholder:text-slate-400 focus:border-brand-500 dark:border-ink-600 dark:bg-ink-900 dark:text-slate-100 dark:placeholder:text-slate-600"
              />
            </div>

            <div>
              <label class="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Номер телефона</label>
              <div class="flex items-center rounded-xl border border-slate-200 bg-slate-50 pl-4 transition-colors duration-200 focus-within:border-brand-500 dark:border-ink-600 dark:bg-ink-900">
                <span class="flex-shrink-0 text-sm font-semibold text-slate-500 dark:text-slate-400">+993</span>
                <input
                  ref="phoneLocalInput"
                  v-model="phoneLocal"
                  type="tel"
                  inputmode="numeric"
                  required
                  placeholder=" XX XXX XX XX"
                  class="w-full bg-transparent py-3 pl-1 pr-4 text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-600"
                  @input="onPhoneLocalInput"
                />
              </div>
            </div>

            <div>
              <label class="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Пароль</label>
              <input
                v-model="password"
                type="password"
                required
                minlength="6"
                placeholder="••••••••"
                class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition-colors duration-200 placeholder:text-slate-400 focus:border-brand-500 dark:border-ink-600 dark:bg-ink-900 dark:text-slate-100 dark:placeholder:text-slate-600"
              />
            </div>

            <transition name="banner">
              <div v-if="errorMessage" class="rounded-xl bg-red-500 bg-opacity-10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                {{ errorMessage }}
              </div>
            </transition>

            <button
              type="submit"
              class="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition-all duration-200 hover:bg-brand-500 active:scale-95 disabled:opacity-60"
              :disabled="submitting"
            >
              <svg v-if="submitting" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
              </svg>
              {{ submitLabel }}
            </button>
          </form>
        </transition>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'DriverAuth',
  data() {
    return {
      mode: 'login',
      // Turkmenistan-only app - +993 is fixed, not something a driver can
      // type over or delete (shown as a static prefix outside the input,
      // see the template). Only the digits after it are ever editable.
      phoneLocal: '',
      password: '',
      fullName: '',
      submitting: false,
      localError: '',
      registerSuccess: ''
    }
  },
  computed: {
    submitLabel() {
      if (this.submitting) return 'Подождите…'
      return this.mode === 'login' ? 'Войти' : 'Зарегистрироваться'
    },
    errorMessage() {
      return this.localError
    },
    logoutMessage() {
      return this.$store.state.driverAuth.logoutMessage
    },
    fullPhone() {
      return `+993${this.phoneLocal.replace(/\s+/g, '')}`
    }
  },
  mounted() {
    if (this.$route.path === '/driverRegister') this.mode = 'register'
  },
  methods: {
    switchMode(mode) {
      this.mode = mode
      this.localError = ''
      this.registerSuccess = ''
    },
    // type="tel" doesn't actually restrict keystrokes (inputmode="numeric"
    // only picks which on-screen keyboard shows) - strip anything that
    // isn't a digit so the "+993" prefix stays the only non-digit part of
    // the whole phone number.
    onPhoneLocalInput(event) {
      this.phoneLocal = event.target.value.replace(/[^0-9]/g, '')
    },
    async submit() {
      this.submitting = true
      this.localError = ''
      this.$store.commit('driverAuth/CLEAR_LOGOUT_MESSAGE')
      try {
        if (this.mode === 'login') {
          await this.$store.dispatch('driverAuth/login', { phone: this.fullPhone, password: this.password })
          this.$router.replace('/driverDashboard')
        } else {
          const data = await this.$store.dispatch('driverAuth/register', {
            phone: this.fullPhone,
            fullName: this.fullName,
            password: this.password
          })
          this.registerSuccess = data.message
        }
      } catch (err) {
        this.localError = (err.response && err.response.data && err.response.data.message) || 'Что-то пошло не так, попробуйте ещё раз'
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
