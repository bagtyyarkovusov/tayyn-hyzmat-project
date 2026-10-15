<template>
  <transition name="modal-fade" appear>
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-black bg-opacity-70 backdrop-blur-sm sm:items-center">
      <div
        class="w-full max-w-sm animate-scale-in rounded-t-3xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-ink-600 dark:bg-ink-900 sm:rounded-3xl"
        role="alertdialog"
        aria-modal="true"
      >
        <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-500 bg-opacity-10 text-red-600 dark:text-red-400">
          <svg viewBox="0 0 24 24" fill="none" class="h-7 w-7">
            <path
              d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linejoin="round"
            />
            <path d="M9.5 7 14.5 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M14.5 7 9.5 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </div>

        <h2 class="mt-4 text-center text-lg font-semibold text-slate-900 dark:text-white">Включите GPS</h2>
        <p class="mt-2 text-center text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          Для работы приложения необходимо разрешить доступ к местоположению
        </p>

        <transition name="fade">
          <p v-if="showHint" class="mt-3 rounded-xl bg-amber-500 bg-opacity-10 px-3 py-2 text-center text-xs text-amber-700 dark:text-amber-400">
            Не получилось включить автоматически. Откройте Настройки → Геолокация на телефоне и включите её вручную.
          </p>
        </transition>

        <div class="mt-6 flex flex-col gap-3 sm:flex-row-reverse">
          <button
            type="button"
            class="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition-all duration-200 hover:bg-brand-500 active:scale-95 disabled:opacity-60"
            :disabled="enabling"
            @click="$emit('enable')"
          >
            <svg v-if="enabling" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
            </svg>
            {{ enabling ? 'Проверяем…' : 'Включить GPS' }}
          </button>
          <button
            type="button"
            class="flex-1 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-600 transition-all duration-200 hover:bg-slate-100 active:scale-95 dark:border-ink-600 dark:text-slate-300 dark:hover:bg-ink-800"
            @click="$emit('logout')"
          >
            Выйти
          </button>
        </div>
      </div>
    </div>
  </transition>
</template>

<script>
export default {
  name: 'GpsRequiredModal',
  props: {
    enabling: { type: Boolean, default: false },
    showHint: { type: Boolean, default: false }
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
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter,
.fade-leave-to {
  opacity: 0;
}
</style>
