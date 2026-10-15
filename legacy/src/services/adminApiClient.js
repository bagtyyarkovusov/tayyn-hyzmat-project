import axios from 'axios';
import * as adminTokenStorage from './adminTokenStorage';

const baseURL = process.env.VUE_APP_API_URL || 'http://localhost:4000';

// Deliberately a separate axios instance from services/apiClient.js: a 401
// here must refresh/logout the ADMIN session, not the driver one. See
// adminTokenStorage.js for why these two panels don't share storage either.
const adminApiClient = axios.create({ baseURL, timeout: 15000 });

adminApiClient.interceptors.request.use((config) => {
  const token = adminTokenStorage.getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Same rotation race the driver client hit (see services/apiClient.js) -
// one shared in-flight refresh so a burst of simultaneous 401s doesn't
// spend the same refresh token twice and log the admin out.
let refreshInFlight = null;
function refreshOnce() {
  if (!refreshInFlight) {
    // eslint-disable-next-line global-require
    const store = require('@/store').default;
    refreshInFlight = store.dispatch('adminAuth/refreshSession').finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

adminApiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const { response, config } = error;
    if (!response) return Promise.reject(error);

    if (response.status === 401 && !config._retry) {
      config._retry = true;
      try {
        // eslint-disable-next-line global-require
        const store = require('@/store').default;
        await refreshOnce();
        config.headers.Authorization = `Bearer ${adminTokenStorage.getAccessToken()}`;
        return adminApiClient(config);
      } catch (refreshError) {
        // eslint-disable-next-line global-require
        const store = require('@/store').default;
        store.dispatch('adminAuth/logout', { message: 'Сессия истекла, войдите снова' });
        return Promise.reject(error);
      }
    }

    return Promise.reject(error);
  }
);

export default adminApiClient;
export { baseURL };
