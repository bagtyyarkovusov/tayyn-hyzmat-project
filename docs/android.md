# Android driver testing

This branch supplies a Firebase-free, user-started shift service. It is a test implementation, integrated with dispatcher credentials and private offers; physical-phone checks below remain required.

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
export VITE_API_URL=https://your-isolated-api.example
export VITE_SOCKET_URL=https://your-isolated-api.example
pnpm cap:sync
cd android
sh ./gradlew :app:assembleDebug :app:testDebugUnitTest
```

Both build URLs must be explicit HTTPS URLs; a packaged WebView cannot use a relative `/api` or its own origin to reach the server. Configure the matching backend `CORS_ORIGIN` to include the APK's default `https://localhost` origin as well as the authorized web origin. Deploy the branch's API/migration to an isolated environment before testing this feature. An APK pointing at the current shared main deployment cannot exercise missing shift endpoints. Do not seed or modify the supporting developer's region database.

The artifact is `android/app/build/outputs/apk/debug/TayynHyzmat-debug.apk`. A debug signature is for testing. Release signing secrets remain ignored. The native-lease migration only adds an empty table; rollback the application first and leave that table until a later forward migration removes it. It never changes region geometry or existing order/balance records.

## Verification and remaining release gates

The combined isolated APK candidate passed 62 public HTTP/Socket.IO tests, 5 backend unit tests, 34 Chromium actor workflows (including focused recovery reruns), TypeScript checks and app-only Android debug assembly/JUnit tests. Public regressions showed transient GPS retry, revoked native stop credentials, unread chat overflow, native shift status broadcasts and account-switch races fail before fixes and pass afterward. The two Java notification-boundary tests cover deduplication, canonical removal/expiry and channel-specific clearing. These checks do not establish native phone behavior.

Before release, run the APK against the matching isolated API on intended Android phones and record:

- Initial permission acceptance, denial, approximate-only location, GPS disabled, permissions revoked, individual channels disabled, and Settings recovery.
- Foreground/background/locked delivery, including 30+ minute stationary Doze, battery saver and manufacturer restrictions; measure order/chat latency and battery use.
- Wi-Fi/mobile switching and lost network beyond 60 seconds; verify server offline/counts and explicit restart after lease expiry.
- Offline/logout, task swipe, process kill, Active apps Stop, Settings Force Stop and reboot; no service resurrection or stale-account notifications.
- Notification taps on cold/warm app, chat scrolling/read reconciliation, order acceptance/decline/expiry and audio/notification clearing.
- Private-offer integration is covered at HTTP seams: reservation privacy, persisted 20-second deadlines, replay identity and removal after acceptance. A timezone regression was caught and fixed. Confirm notification taps and expiry while locked on the physical phone. No client may extend a server deadline.
- Credential-management integration is covered at HTTP seams: leases capture credential versions, reset revokes leases, and the shared user lock prevents an in-flight old renewal/start from restoring availability. Repeat reset and account switching on the physical phone.

The listed local emulator could not boot because its AVD files were unavailable. No emulator or physical-device runtime test, locked-screen/Doze test or release-signature verification has been performed for this branch.

## Isolated Infinix Android 14 test environment

The APK candidate uses `https://apk-api-apk-test.up.railway.app` for both HTTP and Socket.IO; dispatcher testing uses `https://apk-web-apk-test.up.railway.app/adminOrders`. Its PostgreSQL service is fresh and separate from development. Accounts have synthetic 500 TMT opening balances; no payment integration is enabled. Canonical region polygons are seeded from code without reading the shared database. GPS outside these polygons retains the real position and clears the region.

On the Infinix phone, grant precise location and notifications while visible, press GPS until it confirms the server update, then Online. Check foreground, Home, locked screen and network switching with dispatcher orders/chat. Record private-offer delivery time against its 20-second deadline. Check the phone's app battery settings if XOS stops the shift, without assuming an unverified menu path. Test Offline/logout immediately, and Force Stop followed by a 60-second maximum availability lease. Keep financial data synthetic until the independent financial release gates are closed.

Debug builds use package `io.openride.driver.test` and the visible name `Tayyn Hyzmat Test`, so installing this synthetic environment does not replace a separately signed release app. Release signing and package configuration are unchanged. Test credentials are handed over separately and are never embedded in the APK or public download documentation.
