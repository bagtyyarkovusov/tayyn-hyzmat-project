<template>
  <section>
    <div class="mb-2 flex items-center justify-between">
      <h2 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Районы Ашхабада</h2>
    </div>

    <div v-if="loading && !districts.length" class="grid grid-cols-3 gap-2">
      <div v-for="n in 9" :key="n" class="h-16 animate-pulse rounded-2xl border border-slate-200 bg-white dark:border-ink-600 dark:bg-ink-800" />
    </div>

    <transition-group v-else name="card" tag="div" class="grid grid-cols-3 gap-2">
      <DistrictCard
        v-for="district in districts"
        :key="district.id"
        :name="district.name"
        :active-orders="district.activeOrders"
        :free-drivers="district.freeDrivers"
        @click="openDistrict(district)"
      />
    </transition-group>

    <!-- Any of the 9 cards opens this - a driver can accept an order from
         any district now, not just their own (see DistrictOrdersSheet.vue
         and backend orders.service.js#accept). -->
    <DistrictOrdersSheet v-if="selectedDistrict" :district="selectedDistrict" @close="selectedDistrict = null" />
  </section>
</template>

<script>
import DistrictCard from './DistrictCard.vue'
import DistrictOrdersSheet from './DistrictOrdersSheet.vue'

export default {
  name: 'DistrictGrid',
  components: { DistrictCard, DistrictOrdersSheet },
  data() {
    return { selectedDistrict: null }
  },
  computed: {
    districts() {
      return this.$store.getters['districts/sortedByName']
    },
    loading() {
      return this.$store.state.districts.status === 'loading'
    }
  },
  mounted() {
    this.$store.dispatch('districts/fetch').catch(() => {})
  },
  methods: {
    openDistrict(district) {
      this.selectedDistrict = district
    }
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
