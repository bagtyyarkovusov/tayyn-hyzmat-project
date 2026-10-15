// Two implementations behind one interface (`createGeoWatcher`), picked at
// runtime by `Capacitor.isNativePlatform()`:
//  - web: browser Geolocation API (unchanged from the original web app -
//    foreground only, stops once the tab/WebView is backgrounded).
//  - native (the driver APK): @capacitor/geolocation's watchPosition -
//    foreground only, same limitation as the web version (position stops
//    updating once the app is backgrounded/screen off). This USED to be
//    @capacitor-community/background-geolocation, a real Android foreground
//    service that kept reporting in the background - removed after a real
//    Android crash report ("принудительно закрыто из-за исключения
//    нулевого указателя", repeatable, right after login) that persisted
//    even after ruling out battery level and the (separate, also since
//    disabled) push-notifications crash theory. That plugin is a
//    community-maintained one with non-trivial native foreground-service
//    Java code; @capacitor/geolocation is first-party, actively maintained,
//    and has none of that complexity - trading away background tracking
//    for an app that reliably opens is the right call until this can be
//    properly root-caused with real device logs. If background tracking is
//    needed again later, re-add a maintained background-location plugin
//    rather than reinstating this exact one blind.
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';

// timeout was 15s with enableHighAccuracy - a cold GPS fix routinely takes
// longer than that indoors/in an urban canyon, and every timeout flipped
// the driver's status to a hard "GPS выключен" (and, on the home screen,
// hid the district grid behind "Ожидаем сигнал GPS"), even though the
// device was working fine and simply hadn't locked on yet. 45s is a
// realistic ceiling for a first fix; maximumAge lets a fix from the last
// half-minute count instead of forcing a fresh lock on every single tick.
const GEOLOCATION_OPTIONS = { enableHighAccuracy: true, maximumAge: 30000, timeout: 45000 };

// A deliberately cheap, low-accuracy, cache-friendly first read: fires long
// before a high-accuracy lock is available (network/cell/wifi positioning,
// or a cached fix from another app) so the UI has SOMETHING within a second
// or two instead of sitting on "Ожидаем сигнал GPS". watchPosition then
// refines it as the real GPS fix comes in.
const FAST_FIRST_FIX_OPTIONS = { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 };

function createWebGeoWatcher({ onUpdate, onStatusChange }) {
  let watchId = null;
  let permissionStatus = null;

  function evaluatePermission() {
    if (!('permissions' in navigator) || !navigator.permissions.query) return;
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((status) => {
        permissionStatus = status;
        if (status.state === 'denied') onStatusChange(false);
        status.onchange = () => {
          if (status.state === 'denied') onStatusChange(false);
        };
      })
      .catch(() => {
        /* Permissions API not supported (e.g. Safari) - fall back to watchPosition errors only. */
      });
  }

  function start() {
    if (!('geolocation' in navigator)) {
      onStatusChange(false);
      return;
    }
    // Chrome/most Chromium-based browsers refuse navigator.geolocation
    // entirely on an insecure origin (plain http://, except localhost) -
    // watchPosition below will immediately error with PERMISSION_DENIED
    // regardless of whether the device's own GPS/location services are on,
    // which looks identical to "user denied the prompt" from here. This
    // deployment is still on http://<ip> with no domain/TLS yet (see
    // android/README.md) - the driver APK's own WebView loads from a
    // separate, already-secure Capacitor origin and isn't affected by this,
    // only the plain website is.
    if (!window.isSecureContext) {
      // eslint-disable-next-line no-console
      console.warn(
        'Geolocation is unavailable: this page is not a secure context (plain http://, not localhost). ' +
          'GPS will show as off regardless of the device\'s actual GPS state until this site is served over https://.'
      );
    }
    evaluatePermission();

    const emit = (position) => {
      onStatusChange(true);
      onUpdate({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        heading: position.coords.heading == null ? undefined : position.coords.heading,
        speed: position.coords.speed == null ? undefined : position.coords.speed,
        accuracy: position.coords.accuracy == null ? undefined : position.coords.accuracy,
        recordedAt: new Date().toISOString()
      });
    };

    // Same fast-first-fix the native watcher does: a cheap low-accuracy
    // (wifi/cell, possibly cached) read so the UI stops saying "ищем
    // сигнал" within a second or two, instead of waiting out a full
    // high-accuracy lock that on a laptop may never come at all.
    navigator.geolocation.getCurrentPosition(emit, () => {}, FAST_FIRST_FIX_OPTIONS);

    watchId = navigator.geolocation.watchPosition(
      emit,
      (error) => {
        // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT.
        // A timeout is "no lock yet", NOT "GPS is off" - reporting it as off
        // was why the indicator could sit red/amber forever on a slow fix.
        if (error.code === 1 || error.code === 2) onStatusChange(false);
      },
      GEOLOCATION_OPTIONS
    );
  }

  function stop() {
    if (watchId !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = null;
    if (permissionStatus) permissionStatus.onchange = null;
  }

  // Re-prompts the browser's own permission dialog. Works when permission
  // state is "prompt"; does nothing visible once the user has permanently
  // denied it - browsers deliberately don't allow re-prompting after that,
  // the user has to fix it in the browser's own site-settings UI.
  function requestEnable() {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) {
        resolve(false);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        () => {
          onStatusChange(true);
          resolve(true);
        },
        () => resolve(false),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }

  return { start, stop, requestEnable };
}

function createNativeGeoWatcher({ onUpdate, onStatusChange }) {
  let watcherId = null;
  let stopped = false;
  let retryTimer = null;
  let hadFixEver = false;

  // A timeout is NOT "GPS is off" - it's "no lock yet". Reporting it as off
  // was the main reason a driver could sit on "Ожидаем сигнал GPS"
  // indefinitely with location perfectly enabled: one slow first fix
  // flipped the status and nothing ever flipped it back, because the
  // watcher had already been torn down by the error.
  function isTimeoutError(error) {
    const code = error && (error.code !== undefined ? error.code : error.errorCode);
    const message = String((error && error.message) || '').toLowerCase();
    return code === 3 || message.includes('timeout') || message.includes('time out');
  }

  function emitPosition(position) {
    hadFixEver = true;
    onStatusChange(true);
    onUpdate({
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      heading: position.coords.heading == null ? undefined : position.coords.heading,
      speed: position.coords.speed == null ? undefined : position.coords.speed,
      accuracy: position.coords.accuracy == null ? undefined : position.coords.accuracy,
      recordedAt: new Date(position.timestamp || Date.now()).toISOString()
    });
  }

  function handleLocation(position, error) {
    if (error) {
      if (isTimeoutError(error)) {
        // Keep whatever status we already have (a driver who HAS had a fix
        // stays "on"; one who hasn't stays in the neutral "warning" state)
        // and just re-arm the watcher, since Android tears it down on error.
        scheduleRestart();
        return;
      }
      onStatusChange(false);
      scheduleRestart();
      return;
    }
    if (!position) return; // watchPosition can fire a null "still watching, no fix yet" tick
    emitPosition(position);
  }

  function scheduleRestart() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      clearWatcher();
      start();
    }, 5000);
  }

  function clearWatcher() {
    if (watcherId !== null) {
      Geolocation.clearWatch({ id: watcherId }).catch(() => {});
      watcherId = null;
    }
  }

  async function start() {
    stopped = false;
    try {
      // Two-step on Android 11+ (foreground first, background separately) -
      // moot now that this is foreground-only, but requestPermissions still
      // needs to run before watchPosition or it just errors NOT_AUTHORIZED.
      const status = await Geolocation.requestPermissions({ permissions: ['location'] });
      if (status.location !== 'granted' && status.coarseLocation !== 'granted') {
        onStatusChange(false);
        return;
      }

      // Fast, low-accuracy first read so the app isn't blank while the real
      // GPS lock is still being acquired. Failure here is expected and
      // harmless - watchPosition below is the real source of truth.
      if (!hadFixEver) {
        Geolocation.getCurrentPosition(FAST_FIRST_FIX_OPTIONS)
          .then((position) => {
            if (!stopped && position && !hadFixEver) emitPosition(position);
          })
          .catch(() => {});
      }

      watcherId = await Geolocation.watchPosition(GEOLOCATION_OPTIONS, handleLocation);
    } catch (err) {
      onStatusChange(false);
      scheduleRestart();
    }
  }

  function stop() {
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    clearWatcher();
  }

  async function requestEnable() {
    try {
      const status = await Geolocation.requestPermissions({ permissions: ['location'] });
      const granted = status.location === 'granted' || status.coarseLocation === 'granted';
      onStatusChange(granted);
      if (granted && watcherId === null) start();
      return granted;
    } catch (err) {
      return false;
    }
  }

  return { start, stop, requestEnable };
}

export function createGeoWatcher(handlers) {
  return Capacitor.isNativePlatform() ? createNativeGeoWatcher(handlers) : createWebGeoWatcher(handlers);
}

// Best-effort deep link into Android's location settings - only meaningful
// for the plain web build. Inside the native APK, permission prompts are
// real Android system dialogs already (see createNativeGeoWatcher above),
// so there is nothing this needs to work around there.
export function tryOpenAndroidLocationSettings() {
  if (Capacitor.isNativePlatform()) return false;

  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const isChrome = /Chrome/i.test(ua) && !/Edg|OPR|SamsungBrowser/i.test(ua);
  if (!isAndroid || !isChrome) return false;

  try {
    window.location.href = 'intent://#Intent;action=android.settings.LOCATION_SOURCE_SETTINGS;end';
    return true;
  } catch (err) {
    return false;
  }
}
