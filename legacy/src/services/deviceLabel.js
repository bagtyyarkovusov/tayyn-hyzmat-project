// Human-readable device description ("Samsung SM-A047F, Android 13") for
// the admin panel's device-approval UI (see backend auth.service.js#login,
// admin panel AdminDriverDetail.vue) - purely cosmetic, never used for the
// actual device-matching logic, that's still getDeviceId()'s opaque UUID
// (see deviceId.js). @capacitor/device is a no-op-safe plugin (returns
// generic browser info instead of throwing) when running in a plain
// browser rather than the native APK, so this degrades to a best-effort
// user-agent guess there instead of failing outright.
import { Device } from '@capacitor/device';

function guessFromUserAgent() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Android/i.test(ua)) return 'Android (браузер)';
  if (/iPhone|iPad/i.test(ua)) return 'iOS (браузер)';
  return 'Браузер';
}

export async function getDeviceLabel() {
  try {
    const info = await Device.getInfo();
    const parts = [];
    if (info.manufacturer) parts.push(info.manufacturer);
    if (info.model && info.model !== info.manufacturer) parts.push(info.model);
    const platformPart = info.operatingSystem && info.operatingSystem !== 'unknown' ? info.operatingSystem : null;
    const versioned = platformPart ? `${platformPart}${info.osVersion ? ' ' + info.osVersion : ''}` : null;
    const namePart = parts.join(' ');
    const label = [namePart, versioned].filter(Boolean).join(', ');
    return label || guessFromUserAgent();
  } catch (err) {
    return guessFromUserAgent();
  }
}
