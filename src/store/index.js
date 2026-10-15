import Vue from 'vue'
import Vuex from 'vuex'
import driverAuth from './modules/driverAuth'
import ui from './modules/ui'
import districts from './modules/districts'
import order from './modules/order'
import driverChat from './modules/driverChat'
import adminAuth from './modules/adminAuth'
import adminDrivers from './modules/adminDrivers'
import adminOrders from './modules/adminOrders'

Vue.use(Vuex)

export default new Vuex.Store({
  modules: {
    driverAuth,
    ui,
    districts,
    order,
    driverChat,
    adminAuth,
    adminDrivers,
    adminOrders
  }
})
