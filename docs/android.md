# Android driver testing

This branch supplies a Firebase-free, user-started shift service. It is a test implementation, pending the device checks below and integration with dispatcher credential management and private offers.

## Shift behavior

The driver grants precise location and order/chat notification permission while the app is visible, obtains a fresh location acknowledged by the API, and explicitly chooses Online. The native service then owns location reporting and a 10-second authenticated inbox poll independently of the WebView. Orders and chat have separate Android channels. The lock screen shows generic text, without customer phones or chat bodies. Tapping opens the driver home or chat.

The server issues a separate random credential, stores its hash, and renews a 60-second lease only for an approved, online driver on the same approved device with a hardware fix no older than 30 seconds. Event IDs derive from persisted orders/messages; read/accepted/expired items disappear from the next canonical inbox, and native replay deduplicates alerts. Opening chat clears chat alerts; accepting/dismissing clears order alerts. Native channels must remain enabled to continue a shift. Browser notifications remain a foreground fallback, with visible permission feedback.

Home, app switching and screen lock are intended to keep the shift service running. Offline/logout terminate it; swiping the task away also requests termination. The service never restarts itself after process death, reboot or Force Stop. If no callback/network is possible, availability expires at most 60 seconds after the last accepted GPS report; eligibility and regional counts enforce GPS freshness even after a backend restart. A restarted app reconciles the active trip from the API, and a surviving native service supplies its current availability/GPS state. An expired shift requires a new visible Online action.

This transport does not bypass Android Doze. A persistent foreground notification is not proof of timely delivery. In particular, a 20-second private offer can expire before delivery under network/power restrictions; the server deadline remains authoritative.

## Build

Use Node/pnpm from CONTRIBUTING, JDK 17, Android SDK platform 35 and Gradle 8.2.1. The target SDK stays 34; AGP 8.2.1 warns that compile SDK 35 is newer than its tested maximum. No Firebase services/plugin or undeclared Capacitor plugins are required. The local bridge is registered in MainActivity. Gradle wrapper downloads are SHA-256 checked.

```sh
pnpm install --frozen-lockfile
export JAVA_HOME=/path/to/jdk17
export ANDROID_HOME=/path/to/android/sdk
export VITE_API_URL=https://your-isolated-api.example/api
export VITE_SOCKET_URL=https://your-isolated-api.example
pnpm cap:sync
cd android
sh ./gradlew :app:assembleDebug :app:testDebugUnitTest
```

Both build URLs must be explicit HTTPS URLs; a packaged WebView cannot use a relative `/api` or its own origin to reach the server. Configure the matching backend `CORS_ORIGIN` to include the APK's default `https://localhost` origin as well as the authorized web origin. Deploy the branch's API/migration to an isolated environment before testing this feature. An APK pointing at the current shared main deployment cannot exercise missing shift endpoints. Do not seed or modify the supporting developer's region database.

The artifact is `android/app/build/outputs/apk/debug/TayynHyzmat-debug.apk`. A debug signature is for testing. Release signing secrets remain ignored. The native-lease migration only adds an empty table; rollback the application first and leave that table until a later forward migration removes it. It never changes region geometry or existing order/balance records.

## Verification and remaining release gates

On 2026-10-15, the isolated branch passed 27 public HTTP/Socket.IO tests, 5 backend unit tests, 18 Chromium actor workflows, TypeScript checks and app-only Android debug assembly/JUnit tests. Public regressions showed transient GPS retry, revoked native stop credentials, unread chat overflow, native shift status broadcasts and account-switch races fail before fixes and pass afterward. The two Java notification-boundary tests cover deduplication, canonical removal/expiry and channel-specific clearing. These checks do not establish native phone behavior.

Before release, run the APK against the matching isolated API on intended Android phones and record:

- Initial permission acceptance, denial, approximate-only location, GPS disabled, permissions revoked, individual channels disabled, and Settings recovery.
- Foreground/background/locked delivery, including 30+ minute stationary Doze, battery saver and manufacturer restrictions; measure order/chat latency and battery use.
- Wi-Fi/mobile switching and lost network beyond 60 seconds; verify server offline/counts and explicit restart after lease expiry.
- Offline/logout, task swipe, process kill, Active apps Stop, Settings Force Stop and reboot; no service resurrection or stale-account notifications.
- Notification taps on cold/warm app, chat scrolling/read reconciliation, order acceptance/decline/expiry and audio/notification clearing.
- Combined private-offer integration: reservation privacy, original 20-second deadline, fallback and event identity across reconnect. No client may extend a server deadline.
- Combined credential-management integration: captured credential version on leases and immediate invalidation on phone/password reset. `revokeUserShift` is the existing explicit invalidation hook; this independent branch has no credential-version model and does not claim that integration is complete.

The listed local emulator could not boot because its AVD files were unavailable. No emulator or physical-device runtime test, locked-screen/Doze test or release-signature verification has been performed for this branch.
