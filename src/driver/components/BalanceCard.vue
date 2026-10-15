<template>
  <!-- Balance is the number a driver checks most often on this screen, so
       it gets its own full-width block with the amount as the largest thing
       in it, instead of the previous cramped icon+label row where a
       four-digit balance had to compete with the label for width. -->
  <div
    class="relative rounded-2xl border bg-white px-4 py-4 transition-all duration-300 dark:bg-ink-800"
    :class="[isEmpty ? 'border-amber-500 border-opacity-30' : 'border-slate-200 dark:border-ink-600', pulse ? 'ring-2 ring-brand-500' : '']"
  >
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-brand-500 bg-opacity-10 text-brand-600 dark:text-brand-400">
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4">
            <rect x="2.5" y="5.5" width="19" height="13" rx="2.4" stroke="currentColor" stroke-width="1.6" />
            <path d="M2.5 9.5h19" stroke="currentColor" stroke-width="1.6" />
            <circle cx="17.5" cy="14" r="1.3" fill="currentColor" />
          </svg>
        </div>
        <p class="text-sm font-medium text-slate-500">Баланс</p>
      </div>

      <span
        v-if="isEmpty"
        class="flex-shrink-0 rounded-full bg-amber-500 bg-opacity-10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400"
        title="Пополните, чтобы получать заказы"
      >
        Пополните
      </span>
    </div>

    <p class="mt-2 truncate text-3xl font-bold tabular-nums leading-tight text-slate-900 dark:text-white">
      {{ formattedAmount }}
      <span class="text-base font-semibold text-slate-500">{{ currencyLabel }}</span>
    </p>
  </div>
</template>

<script>
const CURRENCY_LABELS = {
  AZN: 'манат',
  USD: '$',
  EUR: '€',
  RUB: '₽',
  TMT: 'TMT'
}

export default {
  name: 'BalanceCard',
  props: {
    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'TMT' }
  },
  data() {
    return { pulse: false }
  },
  computed: {
    isEmpty() {
      return this.amount <= 0
    },
    currencyLabel() {
      return CURRENCY_LABELS[this.currency] || this.currency
    },
    formattedAmount() {
      return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(this.amount)
    }
  },
  watch: {
    // "Изменение баланса" gets a brief highlight ring - a real amount update
    // pushed over the driver:balance-updated WebSocket event, not a mock.
    amount(newVal, oldVal) {
      if (oldVal === undefined) return
      this.pulse = true
      window.clearTimeout(this._pulseTimer)
      this._pulseTimer = window.setTimeout(() => {
        this.pulse = false
      }, 900)
    }
  },
  beforeDestroy() {
    window.clearTimeout(this._pulseTimer)
  }
}
</script>
