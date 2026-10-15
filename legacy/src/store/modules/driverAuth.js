import axios from 'axios';
import apiClient, { baseURL } from '@/services/apiClient';
import * as tokenStorage from '@/services/tokenStorage';
import { connectSocket, disconnectSocket } from '@/services/socketClient';
import { initPushNotifications } from '@/services/pushNotifications';
import { requestNotificationPermission } from '@/services/localNotify';
import { getDeviceId } from '@/services/deviceId';
import { getDeviceLabel } from '@/services/deviceLabel';

// Module-level (not per-dispatch) so afterAuthenticated can safely run more
// than once in a session (logout -> re-login) without stacking duplicate
// visibilitychange listeners each firing their own fetchBalance.
let visibilityRefreshBound = false;

const state = () => ({
  accessToken: '',
  refreshToken: '',
  user: null,
  driver: null,
  balance: null, // { amount, currency }
  status: 'idle', // idle | loading | error
  error: '',
  logoutMessage: '',
  lastAdminMessage: null,
  // Latest GPS sample from locationReporter.js, mirrored into the store so
  // components that aren't using that mixin can read it - ActiveOrderPanel's
  // navigation button needs a start point to hand MAPS.ME.
  lastPosition: null
});

const getters = {
  isAuthenticated: (s) => Boolean(s.accessToken),
  isApprovedDriver: (s) => Boolean(s.driver && s.driver.status === 'APPROVED'),
  driverName: (s) => (s.user ? s.user.fullName : ''),
  balanceAmount: (s) => Number(s.balance ? s.balance.amount : 0),
  balanceCurrency: (s) => (s.balance ? s.balance.currency : 'TMT'),
  hasPositiveBalance: (s, g) => g.balanceAmount > 0
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
  SET_DRIVER(s, driver) {
    s.driver = driver;
  },
  SET_LAST_POSITION(s, position) {
    s.lastPosition = position;
  },
  SET_BALANCE(s, balance) {
    s.balance = balance;
  },
  SET_LOGOUT_MESSAGE(s, message) {
    s.logoutMessage = message;
  },
  CLEAR_LOGOUT_MESSAGE(s) {
    s.logoutMessage = '';
  },
  SET_ADMIN_MESSAGE(s, message) {
    s.lastAdminMessage = message;
  },
  CLEAR_SESSION(s) {
    s.accessToken = '';
    s.refreshToken = '';
    s.user = null;
    s.driver = null;
    s.balance = null;
  }
};

const actions = {
  async register(_ctx, payload) {
    const { data } = await apiClient.post('/auth/register', payload);
    return data;
  },

  async login({ commit, dispatch }, { phone, password }) {
    commit('SET_STATUS', 'loading');
    commit('SET_ERROR', '');
    try {
      const deviceLabel = await getDeviceLabel();
      const { data } = await apiClient.post('/auth/login', { phone, password, deviceId: getDeviceId(), deviceLabel });
      tokenStorage.setTokens(data.accessToken, data.refreshToken);
      commit('SET_SESSION', { accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user });
      dispatch('afterAuthenticated');
      await Promise.all([
        dispatch('fetchProfile'),
        dispatch('fetchBalance'),
        dispatch('order/fetchCurrent', null, { root: true }).catch(() => {})
      ]);
      commit('SET_STATUS', 'idle');
      return data;
    } catch (err) {
      commit('SET_STATUS', 'error');
      const message = (err.response && err.response.data && err.response.data.message) || 'Не удалось войти';
      commit('SET_ERROR', message);
      throw err;
    }
  },

  // Called once a valid access token exists (fresh login, or hydrate on
  // app boot) - opens the realtime channel and wires the events that must
  // react immediately (balance changes, an admin blocking the account).
  afterAuthenticated({ commit, dispatch }) {
    initPushNotifications(); // no-op on the plain web build, see services/pushNotifications.js
    requestNotificationPermission(); // local (not push) new-order alerts, see services/localNotify.js
    connectSocket(() => tokenStorage.getAccessToken(), {
      onBalanceUpdated: (payload) => commit('SET_BALANCE', { amount: payload.amount, currency: payload.currency || 'TMT' }),
      onBlocked: (payload) =>
        dispatch('logout', {
          message: payload && payload.reason ? `Ваш аккаунт заблокирован: ${payload.reason}` : 'Ваш аккаунт заблокирован'
        }),
      onAdminMessage: (payload) => {
        commit('SET_ADMIN_MESSAGE', payload); // drives the existing toast
        dispatch('driverChat/applyIncoming', payload, { root: true }); // drives the unread badge + chat thread
      },
      onDistrictsStats: (payload) => dispatch('districts/applyStats', payload, { root: true }),
      onOrderNew: (payload) => dispatch('order/applyNewOrder', payload, { root: true }),
      onOrderTaken: (payload) => dispatch('order/applyOrderTaken', payload, { root: true }),
      onOrderUpdate: (payload) => dispatch('order/applyOrderUpdate', payload, { root: true })
    });

    // Messages the admin sent while this app was closed produce no socket
    // event, so pull the unread count once on start - otherwise they'd sit
    // in the database with nothing on screen pointing at them.
    dispatch('driverChat/syncUnread', null, { root: true }).catch(() => {});

    // Belt-and-suspenders for "списывается только после обновления
    // страницы" (a WebSocket balance:updated event confirmed arriving
    // correctly via a live server-side test - so a missed live push is
    // most likely the OS suspending/throttling the socket while the app is
    // backgrounded, e.g. MIUI's aggressive background network throttling)
    // - whenever the app comes back to the foreground, refetch balance
    // directly over REST so it's never more than a resume away from
    // correct, independent of whether the live push actually got through.
    if (typeof document !== 'undefined' && !visibilityRefreshBound) {
      visibilityRefreshBound = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) dispatch('fetchBalance').catch(() => {});
      });
    }
  },

  async fetchProfile({ commit }) {
    const { data } = await apiClient.get('/driver/profile');
    commit('SET_DRIVER', data);
    return data;
  },

  async fetchBalance({ commit }) {
    const { data } = await apiClient.get('/driver/balance');
    commit('SET_BALANCE', data);
    return data;
  },

  // Every GPS sample from locationReporter.js - kept so components outside
  // that mixin (ActiveOrderPanel's navigation button) have a start point.
  applyLocationSample({ commit }, position) {
    commit('SET_LAST_POSITION', position);
  },

  // Keeps driverAuth.driver.districtId in sync with the backend's own
  // GPS-derived value (see backend driver.controller.js#postLocation,
  // driven from locationReporter.js#flushLocationQueue on every successful
  // location write). Without this, a driver's client-side "own district"
  // goes stale the moment they physically move after login, since nothing
  // else ever refreshes it (fetchProfile only runs once, at login/hydrate).
  applyLocationDistrict({ commit, state: s }, districtId) {
    if (!s.driver || districtId === undefined || districtId === s.driver.districtId) return
    commit('SET_DRIVER', { ...s.driver, districtId })
  },

  // Manual district fallback - see backend driver.service.js#setDistrict.
  // Only meaningful while GPS can't set it automatically (updateLocation
  // overwrites this on the next successful location report either way).
  async setDistrict({ commit, state: s }, districtId) {
    const { data } = await apiClient.post('/driver/district', { districtId });
    commit('SET_DRIVER', { ...s.driver, districtId: data.districtId, district: data.district });
    return data;
  },

  // Backs the Online/Offline toggle (redesign spec §3). isAvailable mirrors
  // isOnline here deliberately: going online means "ready for new orders";
  // isAvailable is otherwise entirely server-owned (set false/true around
  // an active order - see backend orders.service.js), this is the only
  // place the driver's own toggle drives it.
  async setOnlineStatus({ commit, dispatch, state: s }, isOnline) {
    try {
      const { data } = await apiClient.post('/driver/status', { isOnline, isAvailable: isOnline });
      commit('SET_DRIVER', { ...s.driver, isOnline: data.isOnline, isAvailable: data.isAvailable });
      return data;
    } catch (err) {
      dispatch('ui/pushToast', { body: 'Не удалось изменить статус. Проверьте подключение.', variant: 'error' }, { root: true });
      throw err;
    }
  },

  async refreshSession({ commit }) {
    const refreshToken = tokenStorage.getRefreshToken();
    if (!refreshToken) throw new Error('No refresh token');
    // Plain axios, not apiClient: apiClient's response interceptor is what
    // calls this action in the first place, so routing this call through
    // apiClient too would risk a refresh-triggers-refresh loop.
    const { data } = await axios.post(`${baseURL}/auth/refresh`, { refreshToken });
    tokenStorage.setTokens(data.accessToken, data.refreshToken);
    commit('SET_SESSION', { accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user });
    return data;
  },

  async hydrate({ commit, dispatch }) {
    const accessToken = tokenStorage.getAccessToken();
    const refreshToken = tokenStorage.getRefreshToken();
    if (!accessToken) return;
    commit('SET_SESSION', { accessToken, refreshToken, user: null });
    dispatch('afterAuthenticated');
    try {
      await Promise.all([
        dispatch('fetchProfile'),
        dispatch('fetchBalance'),
        dispatch('order/fetchCurrent', null, { root: true }).catch(() => {})
      ]);
    } catch (err) {
      dispatch('logout');
    }
  },

  logout({ commit }, payload = {}) {
    const refreshToken = tokenStorage.getRefreshToken();
    disconnectSocket();
    tokenStorage.clear();
    commit('CLEAR_SESSION');
    if (payload.message) commit('SET_LOGOUT_MESSAGE', payload.message);
    if (refreshToken) {
      apiClient.post('/auth/logout', { refreshToken }).catch(() => {});
    }
  }
};

export default { namespaced: true, state, getters, mutations, actions };
