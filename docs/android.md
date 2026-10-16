# Android driver testing

This branch supplies a Firebase-free, user-started shift service. It is a test implementation, integrated with dispatcher credentials and private offers; physical-phone checks below remain required.

## Shift behavior

The same driver may stay signed in on multiple approved devices. Signing in on a second device leaves the first device's shift running. Only the shift owner reports the driver's GPS and performs order actions; the second device remains available for viewing the account and chat. To move work to another device, end the current shift, then start a shift there. Logging out of a viewing device does not end the working device's shift. A password/phone change or account block still ends access on all devices. Device approval authorizes login and does not itself transfer a shift.

Deploy the additive device-session migration and matching API before testing this APK behavior. Sessions issued before signed device identities were added require a fresh login. Logout ends all sessions for that installation/browser profile, not sessions on other devices. With no active shift, an approved device can recover the driver's assigned trip without requiring GPS or Online solely to close that trip; starting a new shift re-establishes exclusive ownership.

The driver grants precise location and order/chat notification permission while the app is visible, obtains a fresh location acknowledged by the API, and explicitly chooses Online. The native service then owns location reporting and a 10-second authenticated inbox poll independently of the WebView. Orders and chat have separate Android channels. The lock screen shows generic text, without customer phones or chat bodies. Tapping opens the driver home or chat.

The server issues a separate random credential, stores its hash, and renews a 60-second lease only for an approved, online driver on the same approved device with a hardware fix no older than 30 seconds. Event IDs derive from persisted orders/messages; read/accepted/expired items disappear from the next canonical inbox, and native replay deduplicates alerts. Opening chat clears chat alerts; accepting/dismissing clears order alerts. Native channels must remain enabled to continue a shift. Browser notifications remain a foreground fallback, with visible permission feedback.

Home, app switching and screen lock are intended to keep the shift service running. Offline/logout terminate it; swiping the task away also requests termination. The service never restarts itself after process death, reboot or Force Stop. If no callback/network is possible, availability expires at most 60 seconds after the last accepted GPS report; eligibility and regional counts enforce GPS freshness even after a backend restart. A restarted app reconciles the active trip from the API, and a surviving native service supplies its current availability/GPS state. An expired shift requires a new visible Online action. A retained native stop reason is reconciled once per stop sequence, so it cannot erase a later explicit GPS fix that the server acknowledged. A subsequent stop with the same reason still invalidates readiness. While offline, dispatcher connection feedback uses the foreground socket; an active native shift uses its own last successful report.

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

Both build URLs must be explicit HTTPS URLs; a packaged WebView cannot use a relative `/api` or its own origin to reach the server. Configure the matching backend `CORS_ORIGIN` to include the APK's default `https://localhost` origin as well as the authorized web origin. Deploy the matching API and migrations to an isolated environment before testing. A direct backend origin has no `/api` suffix; that prefix belongs to the web Nginx proxy. Do not seed or modify the supporting developer's region database.

The artifact is `android/app/build/outputs/apk/debug/TayynHyzmat-debug.apk`. A debug signature is for testing. Release signing secrets remain ignored. The native-lease migration only adds an empty table; rollback the application first and leave that table until a later forward migration removes it. It never changes region geometry or existing order/balance records.

## Verification and remaining release gates

An earlier isolated baseline passed 62 public HTTP/Socket.IO tests, 5 backend unit tests, 34 Chromium actor workflows, TypeScript checks and app-only Android debug assembly/JUnit tests. Public regressions showed transient GPS retry, revoked native stop credentials, unread chat overflow, native shift status broadcasts and account-switch races fail before fixes and pass afterward. The two Java notification-boundary tests cover deduplication, canonical removal/expiry and channel-specific clearing. These historical counts do not describe the final candidate's full suite or establish native phone behavior. Match the final APK hash, source commit and deployment to its new build record.

Before release, run the APK against the matching isolated API on intended Android phones and record:

- Initial permission acceptance, denial, approximate-only location, GPS disabled, permissions revoked, individual channels disabled, and Settings recovery.
- Foreground/background/locked delivery, including 30+ minute stationary Doze, battery saver and manufacturer restrictions; measure order/chat latency and battery use.
- Wi-Fi/mobile switching and lost network beyond 60 seconds; verify server offline/counts and explicit restart after lease expiry.
- Offline/logout, task swipe, process kill, Active apps Stop, Settings Force Stop and reboot; no service resurrection or stale-account notifications.
- Notification taps on cold/warm app, chat scrolling/read reconciliation, order acceptance/decline/expiry and audio/notification clearing.
- Private-offer integration is covered at HTTP seams: reservation privacy, persisted 20-second deadlines, replay identity and removal after acceptance. A timezone regression was caught and fixed. Confirm notification taps and expiry while locked on the physical phone. No client may extend a server deadline.
- Credential-management integration is covered at HTTP seams: leases capture credential versions, reset revokes leases, and the shared user lock prevents an in-flight old renewal/start from restoring availability. Repeat reset and account switching on the physical phone.

A local Android 16 emulator was cold-booted successfully. The preceding 1.7-test APK installed and opened to its login screen. This verifies installation and launch only; the updated candidate still needs emulator login and permission checks. Physical Android 14 background delivery, locked-screen/Doze behavior and release-signature verification remain untested.

## Isolated Infinix Android 14 test environment

The APK candidate uses `https://apk-api-apk-test.up.railway.app` for both HTTP and Socket.IO. This direct API base has no `/api` suffix: native login requests `/auth/login` and region requests `/districts`. The web service uses its own `/api` Nginx proxy path; dispatcher testing uses `https://apk-web-apk-test.up.railway.app/adminOrders`. Its PostgreSQL service is fresh and separate from development. Accounts have synthetic 500 TMT opening balances; no payment integration is enabled. Canonical region polygons are seeded from code without reading the shared database. GPS outside these polygons retains the real position and clears the region.

On the Infinix phone, grant precise location and notifications while visible, press GPS until it confirms the server update, then Online. Check foreground, Home, locked screen and network switching with dispatcher orders/chat. Record private-offer delivery time against its 20-second deadline. Check the phone's app battery settings if XOS stops the shift, without assuming an unverified menu path. Test Offline/logout immediately, and Force Stop followed by a 60-second maximum availability lease. Keep financial data synthetic until the independent financial release gates are closed.

Debug builds use package `io.openride.driver.test` and the visible name `Tayyn Hyzmat Test`, so installing this synthetic environment does not replace a separately signed release app. Release signing and package configuration are unchanged. Test credentials are handed over separately and are never embedded in the APK or public download documentation.

Reverse geocoding uses the merged server-side policy: visible-location demand, at least five minutes and 150 metres after the first attempt, a shared daily cap with 20% reserve, and coordinates on provider failure. Provider activation and confirmed quota still require live verification. GPS reporting, saved-boundary region assignment and order eligibility do not depend on address lookup.

## External trip navigation

The trip feed and details offer navigation when the relevant coordinates exist.
Before the passenger boards, the target is pickup. After `Начать поездку`, the
only target is dropoff. If destination coordinates were not supplied, no route
button is shown for a started trip. Call the customer to agree the destination;
the application must not silently route back to pickup.

Android opens the installed Yandex Maps app through an explicit external intent.
If it is unavailable, Android opens the public Yandex web route in a browser.
This handoff needs no geocoder API key. It does not start or finish a trip, end
the shift, or replace the driver WebView. The native shift service continues
subject to the existing GPS, notification and connection lease rules. Return to
Tayyn Hyzmat to mark arrival, start or completion. Completing a trip preserves
an otherwise healthy shift and restores availability for new work.

Test both installed-Yandex and browser-fallback paths on the release phone.
Browser automation verifies route coordinates and the missing-destination rule;
it cannot certify an installed third-party application's routing behavior.
