import apiClient from '@/services/apiClient'

// Чат Водитель ↔ администрация. Mirrors the shape used by the admin panel's
// chat (store/modules/adminDrivers.js#currentMessages) - same Message rows,
// same `senderId` field for bubble alignment, just scoped to "my own"
// conversation instead of picking a driverId.
const state = () => ({
  messages: [],
  unreadCount: 0,
  chatOpen: false, // true while the driver actually has the chat screen mounted
  loading: false
})

const mutations = {
  SET_LOADING(s, loading) {
    s.loading = loading
  },
  SET_MESSAGES(s, messages) {
    s.messages = messages
  },
  APPEND_MESSAGE(s, message) {
    s.messages = [...s.messages, message]
  },
  SET_UNREAD(s, count) {
    s.unreadCount = count
  },
  INCREMENT_UNREAD(s) {
    s.unreadCount += 1
  },
  SET_CHAT_OPEN(s, open) {
    s.chatOpen = open
    if (open) s.unreadCount = 0
  }
}

const actions = {
  // Also carries the server-side unread count (see backend
  // driver.service.js#getMessages) - that's what makes a message sent while
  // the app was closed produce a badge. Before this, unreadCount only ever
  // grew from live socket events, so anything sent to a driver who wasn't
  // connected at that moment showed up nowhere at all.
  async fetchMessages({ commit, state: s }) {
    commit('SET_LOADING', true)
    try {
      const { data } = await apiClient.get('/driver/messages')
      commit('SET_MESSAGES', data.items)
      // If the chat screen is open right now they're reading it live, so
      // don't resurrect a badge behind it.
      if (!s.chatOpen) commit('SET_UNREAD', data.unread || 0)
    } finally {
      commit('SET_LOADING', false)
    }
  },

  // Called once right after login/hydrate so the badge is correct from the
  // first screen, without waiting for the driver to open the chat.
  async syncUnread({ dispatch }) {
    await dispatch('fetchMessages')
  },

  async sendMessage({ commit, state: s }, body) {
    const { data } = await apiClient.post('/driver/messages', { body })
    if (!s.messages.some((m) => m.id === data.id)) commit('APPEND_MESSAGE', data)
  },

  // Driven by the `admin:message` socket event, wired in driverAuth.js
  // alongside the existing toast - "уведомления о новых сообщениях" is this
  // unread counter, which only grows while the chat screen isn't open.
  applyIncoming({ commit, state: s }, payload) {
    if (s.messages.some((m) => m.id === payload.id)) return
    commit('APPEND_MESSAGE', { id: payload.id, senderId: payload.senderId, body: payload.body, sentAt: payload.sentAt })
    if (!s.chatOpen) commit('INCREMENT_UNREAD')
  },

  markOpen({ commit, dispatch }) {
    commit('SET_CHAT_OPEN', true)
    dispatch('fetchMessages')
    // Tell the server everything sent so far has been seen, so the badge
    // doesn't come back on the next app start.
    apiClient.post('/driver/messages/read').catch(() => {})
  },

  markClosed({ commit }) {
    commit('SET_CHAT_OPEN', false)
  }
}

export default { namespaced: true, state, mutations, actions }
