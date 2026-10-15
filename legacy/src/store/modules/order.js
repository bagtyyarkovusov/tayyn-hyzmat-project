import apiClient from '@/services/apiClient'
import { notifyNewOrder, closeCurrentNotification } from '@/services/localNotify'
import { playNewOrderChime, stopNewOrderChime } from '@/services/notificationSound'

// "Если водитель ничего не нажал - через 5 минут автоматически принять."
const AUTO_ACCEPT_MS = 5 * 60 * 1000

// Owned outside `state` on purpose: a setTimeout handle isn't serializable
// reactive state, and it must survive the driver navigating between
// Главная/Карта (component unmount/remount), which a component-local timer
// would not.
let autoAcceptTimer = null

function clearAutoAcceptTimer() {
  if (autoAcceptTimer) {
    window.clearTimeout(autoAcceptTimer)
    autoAcceptTimer = null
  }
}

const state = () => ({
  incoming: null, // { ...order, receivedAt } - the "Новый заказ" popup
  active: null, // current ACCEPTED / WAITING / STARTED order
  lastCompleted: null, // brief summary shown right after COMPLETED
  busy: false,
  error: ''
})

const getters = {
  hasIncoming: (s) => Boolean(s.incoming),
  hasActive: (s) => Boolean(s.active)
}

const mutations = {
  SET_INCOMING(s, order) {
    s.incoming = order ? { ...order, receivedAt: Date.now() } : null
  },
  CLEAR_INCOMING(s) {
    s.incoming = null
  },
  SET_ACTIVE(s, order) {
    s.active = order
  },
  SET_LAST_COMPLETED(s, order) {
    s.lastCompleted = order
  },
  SET_BUSY(s, busy) {
    s.busy = busy
  },
  SET_ERROR(s, error) {
    s.error = error
  }
}

const actions = {
  async fetchCurrent({ commit }) {
    const { data } = await apiClient.get('/orders/current')
    commit('SET_ACTIVE', data)
  },

  // Driven by the `order:new` socket event - starts the 5-minute auto-accept
  // clock centrally so it survives screen navigation. Ignored while the
  // driver already has an incoming or active order (no modal-stacking).
  applyNewOrder({ commit, dispatch, state: s }, order) {
    if (s.active || s.incoming) return
    commit('SET_INCOMING', order)
    playNewOrderChime()
    notifyNewOrder(order)
    clearAutoAcceptTimer()
    autoAcceptTimer = window.setTimeout(() => {
      dispatch('accept', { orderId: order.id, etaMinutes: 5 })
    }, AUTO_ACCEPT_MS)
  },

  applyOrderTaken({ commit, state: s }, payload) {
    if (s.incoming && s.incoming.id === payload.orderId) {
      clearAutoAcceptTimer()
      commit('CLEAR_INCOMING')
      stopNewOrderChime()
      closeCurrentNotification()
    }
  },

  // "Отказаться" in the new-order sheet. There is no reject/decline
  // endpoint on the backend (only accept) - the order keeps broadcasting to
  // every other driver in the district exactly as if this driver had just
  // never seen it. This only hides the popup locally and cancels the local
  // 5-minute auto-accept clock for THIS driver.
  dismissIncoming({ commit }) {
    clearAutoAcceptTimer()
    commit('CLEAR_INCOMING')
    stopNewOrderChime()
    closeCurrentNotification()
  },

  // Any of order:accepted/waiting/started/completed/cancelled for the
  // driver's OWN active order - keeps a second open tab/device in sync.
  applyOrderUpdate({ commit, state: s }, order) {
    if (!s.active || s.active.id !== order.id) return
    if (order.status === 'COMPLETED') {
      commit('SET_ACTIVE', null)
      commit('SET_LAST_COMPLETED', order)
    } else if (order.status === 'CANCELLED') {
      commit('SET_ACTIVE', null)
    } else {
      commit('SET_ACTIVE', order)
    }
  },

  async accept({ commit }, { orderId, etaMinutes }) {
    clearAutoAcceptTimer()
    // Stop ringing the moment the driver answers - before the request even
    // goes out, so the sound doesn't keep playing over a slow network.
    stopNewOrderChime()
    commit('SET_BUSY', true)
    commit('SET_ERROR', '')
    try {
      const { data } = await apiClient.post('/orders/accept', { orderId, etaMinutes })
      commit('CLEAR_INCOMING')
      closeCurrentNotification()
      commit('SET_ACTIVE', data)
    } catch (err) {
      // A 409 just means another driver got there first - not a real
      // error, the modal simply closes like it would on order:taken.
      commit('CLEAR_INCOMING')
      closeCurrentNotification()
      if (!err.response || err.response.status !== 409) {
        commit('SET_ERROR', (err.response && err.response.data && err.response.data.message) || 'Не удалось принять заказ')
      }
    } finally {
      commit('SET_BUSY', false)
    }
  },

  async markWaiting({ commit, state: s }) {
    if (!s.active) return
    commit('SET_BUSY', true)
    try {
      const { data } = await apiClient.post('/orders/waiting', { orderId: s.active.id })
      commit('SET_ACTIVE', data)
    } finally {
      commit('SET_BUSY', false)
    }
  },

  async startTrip({ commit, state: s }) {
    if (!s.active) return
    commit('SET_BUSY', true)
    try {
      const { data } = await apiClient.post('/orders/start', { orderId: s.active.id })
      commit('SET_ACTIVE', data)
    } finally {
      commit('SET_BUSY', false)
    }
  },

  async complete({ commit, dispatch, state: s }) {
    if (!s.active) return
    commit('SET_BUSY', true)
    try {
      const { data } = await apiClient.post('/orders/complete', { orderId: s.active.id })
      commit('SET_ACTIVE', null)
      commit('SET_LAST_COMPLETED', data)
      dispatch('driverAuth/fetchBalance', null, { root: true })
    } finally {
      commit('SET_BUSY', false)
    }
  },

  async cancel({ commit, state: s }, reason) {
    if (!s.active) return
    commit('SET_BUSY', true)
    try {
      await apiClient.post('/orders/cancel', { orderId: s.active.id, reason })
      commit('SET_ACTIVE', null)
    } finally {
      commit('SET_BUSY', false)
    }
  },

  clearLastCompleted({ commit }) {
    commit('SET_LAST_COMPLETED', null)
  }
}

export default { namespaced: true, state, getters, mutations, actions }
