import axios from 'axios';
import * as tokenStorage from './tokenStorage';

const baseURL = process.env.VUE_APP_API_URL || 'http://localhost:4000';

const apiClient = axios.create({ baseURL, timeout: 15000 });

apiClient.interceptors.request.use((config) => {
  const token = tokenStorage.getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Refresh tokens rotate: using one revokes it and issues a replacement (see
// backend auth.service.js#refresh). The driver app has several requests in
// flight at any moment (a location POST every 5s, balance, current order),
// so when a 15-minute access token expires they ALL 401 at once - and
// without this, each one independently called refreshSession with the same
// stored token. The first rotated it, every other one then failed on an
// already-revoked token and logged the driver out with "Сессия истекла".
// One shared in-flight promise means a burst of 401s performs exactly one
// refresh and they all wait on it.
let refreshInFlight = null;
function refreshOnce() {
  if (!refreshInFlight) {
    // eslint-disable-next-line global-require
    const store = require('@/store').default;
    refreshInFlight = store.dispatch('driverAuth/refreshSession').finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// A blocked status (PENDING/BLOCKED) can arrive on ANY authenticated request
// at ANY time - not just at login - because requireApprovedDriver on the
// backend re-checks status on every call, and an admin can block a driver
// mid-session. When that happens here, force a clean logout instead of
// leaving the app in a half-authenticated state.
//
// store is required lazily (inside the handler, not at module load time) so
// this file and store/modules/driverAuth.js can both import from each other
// without a circular-import ordering problem.
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const { response, config } = error;

    if (!response) return Promise.reject(error);

    if (response.status === 401 && !config._retry) {
      config._retry = true;
      try {
        await refreshOnce();
        config.headers.Authorization = `Bearer ${tokenStorage.getAccessToken()}`;
        return apiClient(config);
      } catch (refreshError) {
        // eslint-disable-next-line global-require
        const store = require('@/store').default;
        store.dispatch('driverAuth/logout', { message: 'Сессия истекла, войдите снова' });
        return Promise.reject(error);
      }
    }

    const status = response.data && response.data.details && response.data.details.status;
    if (response.status === 403 && (status === 'PENDING' || status === 'BLOCKED')) {
      // eslint-disable-next-line global-require
      const store = require('@/store').default;
      store.dispatch('driverAuth/logout', { message: response.data.message });
    }

    return Promise.reject(error);
  }
);

export default apiClient;
export { baseURL };
