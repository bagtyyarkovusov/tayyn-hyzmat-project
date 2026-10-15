import adminApiClient from '@/services/adminApiClient'

// A status can belong to more than one filter tab now - ACCEPTED/WAITING/
// STARTED are all still "Активные" (broad in-pipeline view) AND the new,
// narrower "Принятые" tab (a driver has actually taken it, as opposed to
// NEW which is still waiting for one) - see backend admin.service.js's
// matching ORDER_STATUS_GROUPS.
const STATUS_GROUPS = {
  NEW: ['active'],
  ACCEPTED: ['active', 'accepted'],
  WAITING: ['active', 'accepted'],
  STARTED: ['active', 'accepted'],
  COMPLETED: ['completed'],
  CANCELLED: ['cancelled']
}

const state = () => ({
  items: [],
  total: 0,
  page: 1,
  limit: 50,
  statusFilter: 'active', // active | completed | cancelled | all
  loading: false
})

const mutations = {
  SET_LOADING(s, loading) {
    s.loading = loading
  },
  SET_LIST(s, { items, total, page, limit }) {
    s.items = items
    s.total = total
    s.page = page
    s.limit = limit
  },
  SET_STATUS_FILTER(s, statusFilter) {
    s.statusFilter = statusFilter
  },
  UPSERT_ITEM(s, order) {
    const idx = s.items.findIndex((item) => item.id === order.id)
    if (idx === -1) s.items = [order, ...s.items]
    else s.items = s.items.map((item) => (item.id === order.id ? order : item))
  },
  REMOVE_ITEM(s, orderId) {
    s.items = s.items.filter((item) => item.id !== orderId)
  }
}

const actions = {
  async fetchList({ commit, state: s }, { page = 1 } = {}) {
    commit('SET_LOADING', true)
    try {
      const { data } = await adminApiClient.get('/admin/orders', { params: { status: s.statusFilter, page, limit: s.limit } })
      commit('SET_LIST', data)
    } finally {
      commit('SET_LOADING', false)
    }
  },

  setStatusFilter({ commit, dispatch }, statusFilter) {
    commit('SET_STATUS_FILTER', statusFilter)
    dispatch('fetchList', { page: 1 })
  },

  // Manual/phone dispatch - POST /admin/orders already existed on the
  // backend (see backend/src/modules/orders/orders.service.js#createOrder)
  // as "currently the only way an order enters the system at all" since
  // there's no client app yet - this was just never wired to a frontend form.
  async createOrder({ commit, dispatch }, payload) {
    commit('SET_LOADING', true)
    try {
      const { data } = await adminApiClient.post('/admin/orders', payload)
      dispatch('applyOrderEvent', data)
      return data
    } finally {
      commit('SET_LOADING', false)
    }
  },

  // POST /admin/orders/:id/cancel - admin-only cancel that works regardless
  // of whether a driver has accepted yet (see backend orders.service.js#adminCancel).
  async cancelOrder({ dispatch }, { orderId, reason }) {
    const { data } = await adminApiClient.post(`/admin/orders/${orderId}/cancel`, { reason })
    dispatch('applyOrderEvent', data)
    return data
  },

  // Every order:new / order:accepted / .../order:cancelled push lands here.
  // Whether it belongs in the CURRENTLY visible list depends on which
  // status-group filter is active - an order leaving "active" (completed or
  // cancelled) is removed from an active-filtered list rather than shown
  // stale, and appears live in the completed/cancelled tab if that's open.
  applyOrderEvent({ commit, state: s }, order) {
    const groups = STATUS_GROUPS[order.status] || []
    const belongs = s.statusFilter === 'all' || groups.includes(s.statusFilter)
    if (belongs) commit('UPSERT_ITEM', order)
    else commit('REMOVE_ITEM', order.id)
  }
}

export default { namespaced: true, state, mutations, actions }
