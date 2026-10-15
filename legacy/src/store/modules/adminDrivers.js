import adminApiClient from '@/services/adminApiClient'

const state = () => ({
  items: [],
  total: 0,
  page: 1,
  limit: 50,
  statusFilter: '', // '' | PENDING | APPROVED | BLOCKED
  loading: false,
  current: null, // full driver detail (see admin.service.js#getDriver)
  currentHistory: null, // { driver, balance, transactions, orders }
  currentMessages: [],
  // Driver ids with a message the admin hasn't seen yet - shared across
  // admins (see backend schema.prisma's Driver.lastReadByAdminAt comment),
  // seeded from GET /admin/messages/unread (AdminNav.vue, on every admin
  // page load) and kept live by the driver:message socket event below.
  unreadDriverIds: []
})

const getters = {
  onlineCount: (s) => s.items.filter((d) => d.isOnline).length,
  hasUnreadMessages: (s) => s.unreadDriverIds.length > 0,
  isDriverUnread: (s) => (driverId) => s.unreadDriverIds.includes(driverId)
}

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
  SET_CURRENT(s, driver) {
    s.current = driver
  },
  SET_CURRENT_HISTORY(s, history) {
    s.currentHistory = history
  },
  SET_CURRENT_MESSAGES(s, messages) {
    s.currentMessages = messages
  },
  APPEND_CURRENT_MESSAGE(s, message) {
    s.currentMessages = [...s.currentMessages, message]
  },
  PATCH_ITEM(s, { driverId, patch }) {
    s.items = s.items.map((item) => (item.id === driverId ? { ...item, ...patch } : item))
  },
  PATCH_ITEM_BALANCE(s, { driverId, amount }) {
    s.items = s.items.map((item) =>
      item.id === driverId ? { ...item, user: { ...item.user, balance: { ...item.user.balance, amount } } } : item
    )
  },
  SET_UNREAD_DRIVER_IDS(s, ids) {
    s.unreadDriverIds = ids
  },
  MARK_DRIVER_UNREAD(s, driverId) {
    if (!s.unreadDriverIds.includes(driverId)) s.unreadDriverIds = [...s.unreadDriverIds, driverId]
  },
  MARK_DRIVER_READ(s, driverId) {
    if (s.unreadDriverIds.includes(driverId)) s.unreadDriverIds = s.unreadDriverIds.filter((id) => id !== driverId)
  }
}

const actions = {
  async fetchList({ commit, state: s }, { page = 1 } = {}) {
    commit('SET_LOADING', true)
    try {
      const { data } = await adminApiClient.get('/admin/drivers', {
        params: { status: s.statusFilter || undefined, page, limit: s.limit }
      })
      commit('SET_LIST', data)
    } finally {
      commit('SET_LOADING', false)
    }
  },

  setStatusFilter({ commit, dispatch }, statusFilter) {
    commit('SET_STATUS_FILTER', statusFilter)
    dispatch('fetchList', { page: 1 })
  },

  async fetchDetail({ commit }, driverId) {
    const { data } = await adminApiClient.get(`/admin/drivers/${driverId}`)
    commit('SET_CURRENT', data)
    return data
  },

  async fetchHistory({ commit }, driverId) {
    const { data } = await adminApiClient.get(`/admin/drivers/${driverId}/history`, { params: { limit: 50 } })
    commit('SET_CURRENT_HISTORY', data)
    return data
  },

  async fetchMessages({ commit }, driverId) {
    const { data } = await adminApiClient.get(`/admin/drivers/${driverId}/messages`, { params: { limit: 100 } })
    commit('SET_CURRENT_MESSAGES', data.items)
    // Opening this thread is what "read" means (see backend
    // admin.service.js#markMessagesRead) - clears the badge for every
    // admin, not just this one. Fire-and-forget: a failure here shouldn't
    // block the messages the admin is already looking at, and the badge
    // just stays until the next successful open.
    commit('MARK_DRIVER_READ', driverId)
    adminApiClient.post(`/admin/drivers/${driverId}/messages/read`).catch(() => {})
    return data
  },

  async fetchUnread({ commit }) {
    const { data } = await adminApiClient.get('/admin/messages/unread')
    commit('SET_UNREAD_DRIVER_IDS', data.driverIds)
  },

  async approve({ dispatch }, driverId) {
    await adminApiClient.post(`/admin/drivers/${driverId}/approve`)
    await dispatch('fetchDetail', driverId)
    await dispatch('fetchList', { page: 1 })
  },

  async block({ dispatch }, { driverId, reason }) {
    await adminApiClient.post(`/admin/drivers/${driverId}/block`, { reason })
    await dispatch('fetchDetail', driverId)
    await dispatch('fetchList', { page: 1 })
  },

  async unblock({ dispatch }, driverId) {
    await adminApiClient.post(`/admin/drivers/${driverId}/unblock`)
    await dispatch('fetchDetail', driverId)
    await dispatch('fetchList', { page: 1 })
  },

  // Irreversible - see backend admin.service.js#deleteDriver. Refreshes the
  // list rather than patching it locally, since a delete also detaches that
  // driver from their orders elsewhere in the UI.
  async remove({ commit, dispatch }, driverId) {
    await adminApiClient.delete(`/admin/drivers/${driverId}`)
    commit('SET_CURRENT', null)
    await dispatch('fetchList', { page: 1 })
  },

  // Single-device login approval/rejection - see backend admin.service.js#approveDevice.
  async approveDevice({ dispatch }, driverId) {
    await adminApiClient.post(`/admin/drivers/${driverId}/approve-device`)
    await dispatch('fetchDetail', driverId)
  },

  async rejectDevice({ dispatch }, driverId) {
    await adminApiClient.post(`/admin/drivers/${driverId}/reject-device`)
    await dispatch('fetchDetail', driverId)
  },

  // amount is always positive here - `kind` decides the sign, matching the
  // two explicit buttons the admin panel offers ("Пополнить"/"Списать").
  async adjustBalance({ commit, dispatch }, { driverId, amount, kind, note }) {
    const signedAmount = kind === 'withdraw' ? -Math.abs(amount) : Math.abs(amount)
    const type = kind === 'withdraw' ? 'WITHDRAWAL' : 'TOPUP'
    const { data } = await adminApiClient.post(`/admin/drivers/${driverId}/balance`, { amount: signedAmount, type, note })
    commit('PATCH_ITEM_BALANCE', { driverId, amount: data.balance.amount })
    await dispatch('fetchDetail', driverId)
    return data
  },

  // Plate number editing lives here now, not on the driver side (see
  // backend admin.service.js#updateVehicle) - re-fetches the detail record
  // so `driver.currentVehicle.plateNumber` reflects the change immediately.
  async updateVehicle({ dispatch }, { driverId, plateNumber, make, model, color }) {
    await adminApiClient.post(`/admin/drivers/${driverId}/vehicle`, { plateNumber, make, model, color })
    await dispatch('fetchDetail', driverId)
  },

  async sendMessage({ dispatch }, { driverId, body }) {
    await adminApiClient.post('/admin/messages', { driverId, body })
    await dispatch('fetchMessages', driverId)
  },

  // Socket-driven: balance:updated now carries driverId (see backend
  // admin.service.js / orders.service.js) precisely so the list and any
  // open detail view can update live without a refetch.
  applyBalanceUpdate({ commit, state: s }, payload) {
    commit('PATCH_ITEM_BALANCE', { driverId: payload.driverId, amount: payload.amount })
    if (s.current && s.current.id === payload.driverId) {
      commit('SET_CURRENT', { ...s.current, user: { ...s.current.user, balance: { ...s.current.user.balance, amount: payload.amount } } })
    }
  },

  // Driven by both `admin:message` and `driver:message` sockets (both now
  // carry the same shape as the REST history - see backend driver.service.js
  // / admin.service.js, and adminAuth.js for where `fromDriver` gets
  // stamped on). Broadcasts aren't part of a 1:1 thread (same rule as
  // GET /admin/drivers/:id/messages).
  applyIncomingMessage({ commit, state: s }, payload) {
    if (payload.broadcast || !payload.driverId) return

    const threadOpen = Boolean(s.current && s.current.id === payload.driverId)
    if (payload.fromDriver && !threadOpen) {
      // Not looking at this driver's thread right now - that's what the
      // badge is for.
      commit('MARK_DRIVER_UNREAD', payload.driverId)
    }

    if (!threadOpen) return
    if (s.currentMessages.some((m) => m.id === payload.id)) return
    commit('APPEND_CURRENT_MESSAGE', { id: payload.id, senderId: payload.senderId, body: payload.body, sentAt: payload.sentAt })
  }
}

export default { namespaced: true, state, getters, mutations, actions }
