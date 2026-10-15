// In-app update check (DriverProfile.vue) - "доступна новая версия,
// скачать и установить", the way apps outside the Play Store commonly do
// it (ЮMoney and similar). Two halves:
//  - this build's OWN version, from @capacitor/app's App.getInfo() (reads
//    android/app/build.gradle's versionCode/versionName - only meaningful
//    running natively in the APK, not the plain web build)
//  - the LATEST published version, from /apk/latest.json - a static file
//    on the same origin (see /etc/nginx/sites-available/openride's /apk/
//    location), updated by hand after each real release alongside the
//    .apk file it points at (see android/README.md)
import { App } from '@capacitor/app';
import { baseURL } from './apiClient';

export async function getCurrentVersion() {
  try {
    const info = await App.getInfo();
    return { versionCode: Number(info.build), versionName: info.version };
  } catch (err) {
    // Not running in the native APK (plain browser/PWA) - there's nothing
    // to update in that context, so no current version to compare.
    return null;
  }
}

export async function getLatestVersion() {
  const response = await fetch(`${baseURL}/apk/latest.json`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`latest.json ${response.status}`);
  return response.json(); // { versionCode, versionName, url, notes }
}

// Returns the latest-version info if it's actually newer than what's
// running, or null (nothing to offer, or the check itself failed - a
// broken update check must never block or nag inside the app).
export async function checkForUpdate() {
  try {
    const [current, latest] = await Promise.all([getCurrentVersion(), getLatestVersion()]);
    if (!current) return null;
    if (!latest || !Number.isFinite(latest.versionCode)) return null;
    if (latest.versionCode <= current.versionCode) return null;
    return latest;
  } catch (err) {
    return null;
  }
}
