import apiClient from '@/services/apiClient';

const state = () => ({
  items: [], // [{ id, name, activeOrders, freeDrivers }]
  status: 'idle', // idle | loading | error
  lastUpdatedAt: null
});

const getters = {
  sortedByName: (s) => [...s.items].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
};

const mutations = {
  SET_STATUS(s, status) {
    s.status = status;
  },
  SET_ITEMS(s, items) {
    s.items = items;
    s.lastUpdatedAt = new Date().toISOString();
  }
};

const actions = {
  // This module is shared between the driver panel (driver/components/
  // DistrictGrid.vue) and the admin panel (admin/components/DistrictGrid.vue,
  // CreateOrderModal.vue's district dropdown) - GET /districts itself
  // accepts any authenticated role, but the two panels keep entirely
  // separate token storage/axios instances (services/apiClient.js vs
  // services/adminApiClient.js - see adminApiClient.js's own comment on
  // why). Defaulting to the driver's apiClient here silently 401'd every
  // admin-only session (no driver simultaneously logged in in the same
  // browser) - the district list would just never load, no error shown,
  // leaving CreateOrderModal's dropdown empty and forcing a map click
  // instead. Admin call sites now pass adminApiClient explicitly.
  async fetch({ commit }, client = apiClient) {
    commit('SET_STATUS', 'loading');
    try {
      const { data } = await client.get('/districts');
      commit('SET_ITEMS', data);
      commit('SET_STATUS', 'idle');
    } catch (err) {
      commit('SET_STATUS', 'error');
      throw err;
    }
  },
  // Called from driverAuth's socket handler (districts:stats event) - every
  // push is the full 9-row snapshot, so this is a plain replace, not a merge.
  applyStats({ commit }, items) {
    commit('SET_ITEMS', items);
  }
};

export default { namespaced: true, state, getters, mutations, actions };
