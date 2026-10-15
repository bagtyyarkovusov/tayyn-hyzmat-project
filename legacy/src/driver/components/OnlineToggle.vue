<template>
  <StatusPill
    :state="isOnline ? 'on' : 'off'"
    :label="isOnline ? 'Online' : 'Offline'"
    clickable
    :class="{ 'opacity-60': saving }"
    :title="isOnline ? 'Нажмите, чтобы уйти с линии' : 'Нажмите, чтобы выйти на линию'"
    @click="toggle"
  />
</template>

<script>
import StatusPill from './StatusPill.vue'

export default {
  name: 'OnlineToggle',
  components: { StatusPill },
  data() {
    return { saving: false }
  },
  computed: {
    isOnline() {
      const driver = this.$store.state.driverAuth.driver
      return Boolean(driver && driver.isOnline)
    }
  },
  methods: {
    async toggle() {
      if (this.saving) return
      this.saving = true
      try {
        await this.$store.dispatch('driverAuth/setOnlineStatus', !this.isOnline)
      } catch (err) {
        // Toast already shown by the store action.
      } finally {
        this.saving = false
      }
    }
  }
}
</script>
