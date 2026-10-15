// Client-side half of push notifications: request permission, capture the
// FCM registration token, hand it to the backend (POST /driver/push-token).
//
// What this deliberately does NOT do: actually deliver a push. That needs a
// real Firebase project (google-services.json bundled into the APK) and a
// server-side FCM service-account key to call the send API with - neither
// exists in this project. Wiring this now means the moment those two things
// exist, sending a push is the only remaining piece; see backend/README.md.
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import apiClient from './apiClient';

let initialized = false;

// Guards the native calls below on google-services.json genuinely being
// bundled (android/app/build.gradle only applies the
// com.google.gms.google-services Gradle plugin when that file exists - see
// its own comment there). This isn't hypothetical: a real Android crash
// report ("принудительно закрыто из-за исключения нулевого указателя",
// happening right after login, i.e. right when afterAuthenticated calls
// this) matches a well-known Capacitor+FCM gotcha exactly -
// PushNotifications.register() does NOT "silently no-op" without a real
// Firebase project as originally assumed here; the underlying FCM token
// fetch runs on its own native thread outside the awaited call, throws
// there (FirebaseApp not initialized), and crashes the whole app on a
// thread this file's own try/catch below can never reach - JS try/catch
// only ever sees what comes back across the bridge as a rejected promise.
// Flip this once a real google-services.json + backend FCM sending exist
// (see backend/README.md) - nothing else here needs to change.
const FIREBASE_CONFIGURED = false;

export async function initPushNotifications() {
  if (!Capacitor.isNativePlatform() || !FIREBASE_CONFIGURED || initialized) return;
  initialized = true;

  try {
    let permission = await PushNotifications.checkPermissions();
    if (permission.receive === 'prompt') {
      permission = await PushNotifications.requestPermissions();
    }
    if (permission.receive !== 'granted') return;

    PushNotifications.addListener('registration', (token) => {
      apiClient.post('/driver/push-token', { token: token.value }).catch(() => {
        // Non-fatal: the driver app works fully without push, this is best-effort.
      });
    });

    PushNotifications.addListener('registrationError', () => {
      // Most commonly: no google-services.json bundled yet (see comment above).
    });

    await PushNotifications.register();
  } catch (err) {
    // Never let push setup block the rest of the app from working.
  }
}
