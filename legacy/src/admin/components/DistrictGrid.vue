<template>
  <section>
    <div class="mb-2 flex items-center justify-between">
      <h2 class="text-sm font-semibold text-slate-600 dark:text-slate-300">Районы Ашхабада</h2>
      <span class="text-xs text-slate-500">заказы : машины</span>
    </div>

    <div v-if="loading && !districts.length" class="grid grid-cols-3 gap-2">
      <div v-for="n in 9" :key="n" class="animate-pulse rounded-2xl border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900" style="aspect-ratio: 1 / 1;" />
    </div>

    <transition-group v-else name="card" tag="div" class="grid grid-cols-3 gap-2">
      <DistrictCard
        v-for="district in districts"
        :key="district.id"
        :name="district.name"
        :active-orders="district.activeOrders"
        :free-drivers="district.freeDrivers"
      />
    </transition-group>
  </section>
</template>

<script>
import DistrictCard from './DistrictCard.vue'
import adminApiClient from '@/services/adminApiClient'

export default {
  name: 'DistrictGrid',
  components: { DistrictCard },
  computed: {
    districts() {
      return this.$store.getters['districts/sortedByName']
    },
    loading() {
      return this.$store.state.districts.status === 'loading'
    }
  },
  mounted() {
    // Must pass adminApiClient - the shared districts/fetch action defaults
    // to the driver panel's client, which has no token in an admin-only
    // session (see store/modules/districts.js's comment).
    this.$store.dispatch('districts/fetch', adminApiClient).catch(() => {})
  }
}
</script>

<style scoped>
.card-enter-active,
.card-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.card-enter,
.card-leave-to {
  opacity: 0;
  transform: scale(0.9);
}
</style>
