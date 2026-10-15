<template>
  <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-ink-600 dark:bg-ink-800">
    <div class="min-w-0">
      <p class="text-xs font-medium text-slate-500">Госномер</p>
      <p class="truncate text-base font-semibold text-slate-900 dark:text-slate-100">{{ plateNumber || 'не указан' }}</p>
      <p class="mt-0.5 text-xs text-slate-500">Изменить может только администратор</p>
    </div>

    <transition name="fade">
      <p v-if="subtitle" class="mt-2 truncate text-xs text-slate-500">{{ subtitle }}</p>
    </transition>
  </div>
</template>

<script>
export default {
  name: 'VehicleCard',
  props: {
    // Optional extra line under the plate - DriverProfile.vue leaves it empty.
    subtitle: { type: String, default: '' }
  },
  computed: {
    plateNumber() {
      const driver = this.$store.state.driverAuth.driver
      return driver && driver.currentVehicle ? driver.currentVehicle.plateNumber : ''
    }
  }
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter,
.fade-leave-to {
  opacity: 0;
}
</style>
