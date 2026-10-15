import apiClient from '@/services/apiClient'
import { notifyNewOrder, closeCurrentNotification } from '@/services/localNotify'
import { playNewOrderChime, stopNewOrderChime } from '@/services/notificationSound'

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

  // Incoming offers remain unclaimed until the driver explicitly accepts.
  // Ignore stacking while this driver has an incoming or active order.
  applyNewOrder({ commit, state: s }, order) {
    if (s.active || s.incoming) return
    commit('SET_INCOMING', order)
    playNewOrderChime()
    notifyNewOrder(order)
  },

  applyOrderTaken({ commit, state: s }, payload) {
    if (s.incoming && s.incoming.id === payload.orderId) {
      commit('CLEAR_INCOMING')
      stopNewOrderChime()
      closeCurrentNotification()
    }
  },

  // "Отказаться" in the new-order sheet. There is no reject/decline
  // endpoint on the backend (only accept) - the order keeps broadcasting to
  // every other driver in the district exactly as if this driver had just
  // never seen it. This only hides the popup locally.
  dismissIncoming({ commit }) {
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
