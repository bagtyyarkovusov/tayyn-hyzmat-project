import axios from 'axios';
import adminApiClient, { baseURL } from '@/services/adminApiClient';
import * as adminTokenStorage from '@/services/adminTokenStorage';
import { connectSocket, disconnectSocket } from '@/services/socketClient';

const state = () => ({
  accessToken: '',
  refreshToken: '',
  user: null, // includes .admin { permissionLevel } straight from /auth/login
  status: 'idle', // idle | loading | error
  error: '',
  logoutMessage: ''
});

const getters = {
  isAuthenticated: (s) => Boolean(s.accessToken),
  adminName: (s) => (s.user ? s.user.fullName : ''),
  permissionLevel: (s) => (s.user && s.user.admin ? s.user.admin.permissionLevel : '')
};

const mutations = {
  SET_STATUS(s, status) {
    s.status = status;
  },
  SET_ERROR(s, error) {
    s.error = error;
  },
  SET_SESSION(s, { accessToken, refreshToken, user }) {
    s.accessToken = accessToken;
    s.refreshToken = refreshToken;
    if (user) s.user = user;
  },
  SET_LOGOUT_MESSAGE(s, message) {
    s.logoutMessage = message;
  },
  CLEAR_LOGOUT_MESSAGE(s) {
    s.logoutMessage = '';
  },
  CLEAR_SESSION(s) {
    s.accessToken = '';
    s.refreshToken = '';
    s.user = null;
  }
};

const actions = {
  async login({ commit, dispatch }, { phone, password }) {
    commit('SET_STATUS', 'loading');
    commit('SET_ERROR', '');
    try {
      const { data } = await adminApiClient.post('/auth/login', { phone, password });
      if (data.user.role !== 'ADMIN') {
        // /auth/login is role-agnostic (same endpoint the driver panel
        // uses) - without this check, a driver's own credentials would
        // silently "work" here too and just fail confusingly later.
        const err = new Error('Этот аккаунт не является администратором');
        err.response = { data: { message: err.message } };
        throw err;
      }
      adminTokenStorage.setTokens(data.accessToken, data.refreshToken);
      commit('SET_SESSION', { accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user });
      dispatch('afterAuthenticated');
      commit('SET_STATUS', 'idle');
      return data;
    } catch (err) {
      commit('SET_STATUS', 'error');
      const message = (err.response && err.response.data && err.response.data.message) || 'Не удалось войти';
      commit('SET_ERROR', message);
      throw err;
    }
  },

  // Opens the realtime channel for everything the admin panel needs to stay
  // live without polling: district counts, order lifecycle, driver balance
  // changes, and both directions of the Админ ↔ водитель chat.
  afterAuthenticated({ commit, dispatch }) {
    connectSocket(() => adminTokenStorage.getAccessToken(), {
      onDistrictsStats: (payload) => dispatch('districts/applyStats', payload, { root: true }),
      onBalanceUpdated: (payload) => dispatch('adminDrivers/applyBalanceUpdate', payload, { root: true }),
      onOrderNew: (payload) => dispatch('adminOrders/applyOrderEvent', payload, { root: true }),
      onOrderUpdate: (payload) => dispatch('adminOrders/applyOrderEvent', payload, { root: true }),
      // Both events reach the same action, but only a driver's own message
      // should ever light up the unread badge - an admin's own outgoing
      // message just echoes to other admin sessions/tabs as a reply, not a
      // "new" message to read. `fromDriver` is stamped here (not inferred
      // from payload shape in the action) since admin:message and
      // driver:message payloads are otherwise almost identical - see
      // backend admin.service.js#sendMessage vs driver.service.js#sendMessage.
      onAdminMessage: (payload) => dispatch('adminDrivers/applyIncomingMessage', { ...payload, fromDriver: false }, { root: true }),
      onDriverMessage: (payload) => dispatch('adminDrivers/applyIncomingMessage', { ...payload, fromDriver: true }, { root: true })
    });
  },

  async refreshSession({ commit }) {
    const refreshToken = adminTokenStorage.getRefreshToken();
    if (!refreshToken) throw new Error('No refresh token');
    const { data } = await axios.post(`${baseURL}/auth/refresh`, { refreshToken });
    adminTokenStorage.setTokens(data.accessToken, data.refreshToken);
    commit('SET_SESSION', { accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user });
    return data;
  },

  async hydrate({ commit, dispatch }) {
    const accessToken = adminTokenStorage.getAccessToken();
    const refreshToken = adminTokenStorage.getRefreshToken();
    if (!accessToken) return;
    commit('SET_SESSION', { accessToken, refreshToken, user: null });
    dispatch('afterAuthenticated');
    try {
      await adminApiClient.get('/admin/drivers?limit=1');
    } catch (err) {
      dispatch('logout');
    }
  },

  logout({ commit }, payload = {}) {
    const refreshToken = adminTokenStorage.getRefreshToken();
    disconnectSocket();
    adminTokenStorage.clear();
    commit('CLEAR_SESSION');
    if (payload.message) commit('SET_LOGOUT_MESSAGE', payload.message);
    if (refreshToken) {
      adminApiClient.post('/auth/logout', { refreshToken }).catch(() => {});
    }
  }
};

export default { namespaced: true, state, getters, mutations, actions };
