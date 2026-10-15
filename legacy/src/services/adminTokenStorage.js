// Mirrors services/tokenStorage.js but under separate localStorage keys.
// Kept as its own file (not a parametrized shared factory) so an admin
// session and a driver session can never collide in the same browser, and
// so each panel's auth wiring stays trivially easy to trace end to end -
// admin and driver are different apps in practice, this SPA just happens to
// bundle both during early development (see migration plan).
const ACCESS_KEY = 'openride.admin.accessToken';
const REFRESH_KEY = 'openride.admin.refreshToken';

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
