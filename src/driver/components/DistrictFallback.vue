<template>
  <section class="rounded-2xl border border-amber-500 border-opacity-30 bg-amber-500 bg-opacity-10 p-4">
    <p class="text-sm font-semibold text-amber-700 dark:text-amber-400">GPS недоступен — выберите район вручную</p>
    <p class="mt-1 text-xs text-amber-700 text-opacity-80 dark:text-amber-400">Без района новые заказы не будут приходить</p>

    <select
      v-model="selected"
      class="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-amber-500 dark:border-ink-600 dark:bg-ink-900 dark:text-slate-100"
      :disabled="saving"
      @change="submit"
    >
      <option value="" disabled>Выберите район…</option>
      <option v-for="d in districts" :key="d.id" :value="d.id">{{ d.name }}</option>
    </select>

    <p v-if="currentDistrictName" class="mt-2 text-xs text-slate-500">Сейчас: {{ currentDistrictName }}</p>
    <p v-if="error" class="mt-2 text-xs text-red-600 dark:text-red-400">{{ error }}</p>
  </section>
</template>

<script>
export default {
  name: 'DistrictFallback',
  data() {
    return { selected: '', saving: false, error: '' }
  },
  computed: {
    districts() {
      return this.$store.getters['districts/sortedByName']
    },
    currentDistrictName() {
      const driver = this.$store.state.driverAuth.driver
      return driver && driver.district ? driver.district.name : ''
    }
  },
  mounted() {
    // Same store the districts grid uses - dispatching again here too is
    // harmless (Vuex just re-fetches) and means this dropdown has options
    // even if it happens to mount before DistrictGrid does.
    this.$store.dispatch('districts/fetch').catch(() => {})
  },
  methods: {
    async submit() {
      if (!this.selected || this.saving) return
      this.saving = true
      this.error = ''
      try {
        await this.$store.dispatch('driverAuth/setDistrict', this.selected)
        this.$store.dispatch('ui/pushToast', { title: 'Район выбран', body: this.currentDistrictName, variant: 'success' })
      } catch (err) {
        this.error = (err.response && err.response.data && err.response.data.message) || 'Не удалось выбрать район'
      } finally {
        this.saving = false
      }
    }
  }
}
</script>
