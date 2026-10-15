// Single source of truth for where driver JWTs live in the browser. Kept as
// a tiny standalone module (no Vuex/axios imports) specifically so both
// apiClient.js and the driverAuth Vuex module can depend on it without
// creating an import cycle between the two.
const ACCESS_KEY = 'openride.driver.accessToken';
const REFRESH_KEY = 'openride.driver.refreshToken';

export function getAccessToken() {
  return localStorage.getItem(ACCESS_KEY) || '';
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY) || '';
}

export function setTokens(accessToken, refreshToken) {
  if (accessToken) localStorage.setItem(ACCESS_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clear() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}
