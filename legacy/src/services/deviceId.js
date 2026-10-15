// A stable per-installation identifier for the single-device login rule
// (see backend auth.service.js#login) - generated once and kept in
// localStorage, which survives app restarts on the same device/browser
// profile and only goes away on an uninstall or a manual site-data clear,
// which is exactly the "device" granularity the rule is meant to enforce.
// Not a hardware fingerprint - that's deliberate, it doesn't need to
// survive a reinstall, it just needs to keep the same value across normal
// use of the same installation.
const STORAGE_KEY = 'openride.driver.deviceId';

function generateId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  // Fallback for older WebViews without crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getDeviceId() {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = generateId();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
