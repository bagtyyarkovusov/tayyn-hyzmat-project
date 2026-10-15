<template>
  <div>
    <NewOrderModal v-if="incoming" :order="incoming" />
    <ActiveOrderPanel v-else-if="active" :order="active" />
  </div>
</template>

<script>
import NewOrderModal from './NewOrderModal.vue'
import ActiveOrderPanel from './ActiveOrderPanel.vue'

export default {
  name: 'OrderOverlay',
  components: { NewOrderModal, ActiveOrderPanel },
  computed: {
    incoming() {
      return this.$store.state.order.incoming
    },
    active() {
      return this.$store.state.order.active
    },
    lastCompleted() {
      return this.$store.state.order.lastCompleted
    }
  },
  watch: {
    // The "order completed" notification is now just another entry in the
    // shared toast queue (see driver/components/ToastHost.vue, mounted once
    // in DriverApp.vue) instead of its own bespoke banner/timer.
    lastCompleted(value) {
      if (!value) return
      const price = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(value.priceFinal || 0))
      this.$store.dispatch('ui/pushToast', {
        title: 'Заказ завершён',
        body: `Списано с баланса: ${price} TMT`,
        variant: 'success'
      })
      this.$store.dispatch('order/clearLastCompleted')
    }
  }
}
</script>
