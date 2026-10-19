# Android driver testing

The Android driver build uses a native foreground shift service and Firebase Cloud Messaging as a fallback transport for persisted notification events. The backend remains the source of truth for shifts, GPS eligibility, chats, offers and claims. Physical-phone checks below remain required.

## Shift behavior

The same approved driver account may stay signed in on multiple phones without separate device approval. Signing in on a second device leaves the first device's shift running. Only the shift owner reports the driver's GPS and performs order actions; the second device remains available for viewing the account and chat. To move work to another device, end the current shift, then start a shift there. Logging out of a viewing device does not end the working device's shift. A password/phone change or account block still ends access on all devices. The installation identity stays internal; there is no device approval or management screen.

Deploy the additive device-session migration and matching API before testing this APK behavior. Sessions issued before signed device identities were added require a fresh login. Logout ends all sessions for that installation/browser profile, not sessions on other devices. With no active shift, a signed-in phone can recover the driver's assigned trip without requiring GPS or Online solely to close that trip; starting a new shift re-establishes exclusive ownership.

After the first verified driver login in the APK, request precise location first and notification permission second. Public login, registration, dispatcher screens and browsers do not request these automatically. Denial or dismissal is remembered on that installation; The Online button opens Android permission or location settings for deliberate recovery without repeated login/reload prompts. The GPS and connection indicators never open settings or accept taps. Location refusal still permits the separate notification prompt. Permission prompts never start a shift or upload an off-shift location.

The driver grants precise location while the home-screen location view is visible, obtains a fresh local location, and explicitly chooses Online. Off-shift GPS never updates shared tracking. One foreground convenience address request may use a transient fresh point without changing the dispatcher map. Online sends that fix and acquires ownership atomically; only its owner uploads recurring positions. Notification permission and OS channel settings do not block Online. The native service owns location reporting and a 10-second authenticated inbox poll independently of the WebView. After signed installation registration, polling, Socket.IO and FCM use one canonical native renderer. Registration does not require a configured Firebase transport. Before registration, polling cannot independently render a second alert. Orders and chat have separate Android channels. The lock screen uses Android private visibility and never includes customer phones. Chat previews follow the platform lock-screen policy. Tapping opens the driver home or chat.

The server issues a separate random credential, stores its hash, and renews a 60-second lease only for an approved, online driver on the same signed-in installation with a fresh hardware fix. Order IDs are exact per-attempt `notificationEventId` values supplied by the server, including `offerAttemptId`; chat IDs derive from persisted messages; read/accepted/expired items disappear from the next canonical inbox, and native replay deduplicates alerts. Opening chat clears chat alerts; accepting/dismissing clears order alerts. There is no application mute preference. OS permission, channel sound, silent mode and DND remain authoritative. Browser notifications remain a foreground fallback, with visible permission feedback.

Home, app switching, screen lock and swiping the task away are intended to keep the foreground shift service and its lease running. Offline/logout terminate it. Android Force Stop, process death, reboot and manufacturer task-killing can stop it; the service does not resurrect itself after those boundaries. If no callback/network is possible, availability expires at most 60 seconds after the last accepted GPS report; eligibility and regional counts enforce GPS freshness even after a backend restart. A restarted app reconciles the active trip from the API, and a surviving native service supplies its current availability/GPS state. An expired shift requires a new visible Online action. A retained native stop reason is reconciled once per stop sequence, so it cannot erase a later explicit GPS fix that the server acknowledged. A subsequent stop ends availability but preserves a still-fresh local fix; it never renews the fix timestamp. Native local GPS age comes from the hardware fix time, independently of the last successful server report. While offline, dispatcher connection feedback uses the foreground socket; an active native shift uses its own last successful report.

This transport does not bypass Android Doze. A persistent foreground notification is not proof of timely delivery. In particular, a 20-second private offer can expire before delivery under network/power restrictions; the server deadline remains authoritative.

## Build

Use Node/pnpm from CONTRIBUTING, JDK 17, Android SDK platform 35 and Gradle 8.2.1. The target SDK stays 34; AGP 8.2.1 warns that compile SDK 35 is newer than its tested maximum. Firebase Messaging 24.1.2 and Google services 4.4.2 are included. The Google services plugin activates only when the ignored variant configuration exists, so clean CI builds remain possible. The local bridge is registered in MainActivity. Gradle wrapper downloads are SHA-256 checked.

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

### Production package and first installation

The production APK uses application ID `tayyn.hyzmat.production`, registered in the existing Firebase project `tayyn-hyzmat`. The debug APK keeps `io.openride.driver.test`. Java classes and the Android namespace remain `io.openride.driver`; these internal names do not determine which app Android installs. Capacitor's app ID matches the production application ID, and the manifest's FileProvider authority follows the selected variant automatically.

Place the matching Firebase Android configuration in ignored `android/app/src/release/google-services.json`, mode `0600`. Keep the compatible test configuration in `android/app/src/debug/google-services.json`. These client files configure the APK; the separate Firebase Admin service-account credential belongs only on the production backend and must never enter Android assets or an APK. The current candidate version is `1.20`, code `21`.

This new production package has a newly generated production signing identity, separate from earlier test/legacy keys. The ignored `android/keystore/tayyn-hyzmat-production.jks` and `android/keystore/keystore.properties` are local build secrets. The keystore uses independent strong store and key passwords. Both files have mode `0600`, inside a `0700` directory. A protected local duplicate and owner instructions are under ignored `.local/vps-bootstrap/keys/android-production/`. The owner must copy both files to encrypted offline storage; two copies on the same Mac do not protect against loss of that machine. Never put these signing files on either VPS, in Git or in an APK. Preserve this key for every future production update. Losing it prevents in-place updates to already installed production APKs.

Build the production candidate only after its backend certificate, API and migrations are verified:

```sh
export VITE_API_URL=https://taxi.tayynhyzmat.com/api
export VITE_SOCKET_URL=https://taxi.tayynhyzmat.com
pnpm android:assembleRelease
```

The production API uses the dashboard proxy's `/api` prefix; Socket.IO uses the host origin. The resulting file is `android/app/build/outputs/apk/release/TayynHyzmat-release.apk`. Record its SHA-256, source commit, signing certificate and application ID before sharing it.

This package identity installs as a separate app from both the old `io.openride.driver` release and the test APK. It cannot update either in place. Drivers sign in and grant permissions again; local sessions, notification tokens and permissions do not transfer. The first production install registers its own FCM token with the production backend. End any old test shift before testing the new app. Future production updates can install over this APK when the package ID and signing key stay unchanged and the version code increases. Keeping the same Firebase project preserves the provider setup, but does not migrate Android app storage or sessions.

## Verification and remaining release gates

The isolated baseline passed its recorded HTTP/Socket.IO, backend, browser and Android checks. The current Java notification-policy tests cover deduplication, canonical removal/expiry, channel-specific clearing and conservative server-expiry conversion. Run the final repository checks before release. These checks establish code behavior, not Firebase delivery or native-phone survival. Match the final APK hash, source commit and backend deployment to its new build record.

Before release, run the APK against the matching isolated API on intended Android phones and record:

- Initial precise-location acceptance, denial, approximate-only location, GPS disabled, permissions revoked, notification permission denial, channel mute and Settings recovery.
- Foreground/background/locked delivery, including 30+ minute stationary Doze, battery saver and manufacturer restrictions; measure order/chat latency and battery use.
- Wi-Fi/mobile switching and lost network beyond 60 seconds; verify server offline/counts and explicit restart after lease expiry.
- Offline/logout, task swipe, process kill, Active apps Stop, Settings Force Stop and reboot. Confirm task swipe preserves the lease while Force Stop stops delivery until the app is reopened, and that neither path produces stale-account notifications.
- Notification taps on cold/warm app, chat scrolling/read reconciliation, order acceptance/decline/expiry and audio/notification clearing.
- Private-offer integration is covered at HTTP seams: reservation privacy, persisted 20-second deadlines, replay identity and removal after acceptance. A timezone regression was caught and fixed. Confirm notification taps and expiry while locked on the physical phone. No client may extend a server deadline.
- Credential-management integration is covered at HTTP seams: leases capture credential versions, reset revokes leases, and the shared user lock prevents an in-flight old renewal/start from restoring availability. Repeat reset and account switching on the physical phone.

The current Android 16 emulator did not boot during this pass. Earlier installation evidence only verifies launch, not the current candidate. Physical Android 14 background delivery, locked-screen/Doze behavior, FCM reachability and release-signature verification remain untested.

## Release 1.20 native changes and verification

The bridge contract is [driver rollout native contract](plans/driver-rollout-1.20-native-contract.md). The app shell owns overlay dismissal and route hierarchy. Android consumes keyboard Back first, then requests one web action with an expiring request ID. A handled overlay/navigation resets the root exit window. Two root Back presses within two seconds minimize the task with `moveTaskToBack(true)` and preserve the active shift. Startup without a ready WebView has the same bounded native fallback. Back never accepts or privately declines an offer. A newly shown offer ignores Back for its first second: the shell answers root, so Android shows the minimize hint (or minimizes on a second press within two seconds) and the offer stays open. A web answer that misses the 1.5-second native deadline is treated as a root press, and its late answer is ignored. Back and X are refused while an accept, decline or trip cancellation is pending.

Both system bars stay visible. The native bridge reports system-bar and cutout insets in CSS pixels; the web shell owns safe padding. IME height remains separate from persistent bar insets. Status/navigation icon appearance follows the app theme, with dark fallback bar backgrounds on APIs that lack dark system icons. Verify rotation, both themes, keyboard layout, cutouts and gesture/three-button navigation on the actual phone.

The browser offer track and Android raw resource are identical, decoded duration 19.95 seconds, cut from the previous 41.142857-second music with a short fade-in and a 1.75-second fade-out. Browser order music is capped at canonical remaining time or 20 seconds. Chat uses an independent short asset. The WebView never plays order music on Android. Android uses only the OS notification sound, with notification audio attributes, on `driver-orders-v120`. The new channel migrates the old channel's importance, silent/custom sound and other OS choices; the upgrade does not bypass an existing OS block or silence choice. It does not request DND access or use a fullscreen/overlay intent. No manual media player competes with Android's audio-focus/call policy.

One native coordinator replaces the current attempt, cancels only matching IDs, and uses a monotonic remaining deadline capped at 20 seconds. Exact dismissal before verification is persisted so delayed FCM/socket/poll responses cannot restart that attempt. Canonical polling cancels disappeared IDs only after a successful authenticated inbox response and protects arrivals after the request snapshot. Foreground reconciliation also compares authoritative serverTime with each native verification time. A network failure is never treated as an empty inbox. Notification tap/swipe, accept, X/Back, expiry, invalidation, logout, GPS/shift loss and replacement share the cancellation boundary. Natural sound is finite; Android notification timeout is an additional deadline backstop on API 26+.

Local verification on 2026-10-18 used JDK 17 and SDK 35. Native unit tests, javac policy tests, Gradle debug assembly, unsigned minified release assembly and debug lint pass. The 20 policy tests use real policy/coordinator modules with only disk/OS notification/timer boundaries replaced. Deliberately replacing a five-second remaining duration with a new 20 seconds makes three tests fail. Lint reports zero errors and 24 warnings, mostly inherited resource/compatibility warnings. These builds use a generated minimal web fixture to isolate native compilation while the web agent integrates the shell; they are not distributable release candidates. Parent integration must rebuild from the final web source with the required HTTPS endpoints and signing identity.

The T3 Device panel could list `Tayyn_Hyzmat_Test`, but opening it failed with `The simulator or emulator could not start. Check its configuration on the environment server.` No current native UI or audio behavior was observed on an emulator or phone. In particular, immediate audible stop when a long system notification sound is cancelled is **unverified**. Do not treat the fake OS sink's cancellation assertion as acoustic evidence. Verify five-seconds-remaining audio, canonical disappearance/accept on another device, same-order reoffer, swipe/tap/timeout, process suspension, locked/Doze, permission/channel disabled or silent, DND, calls/external audio focus, Back/IME/overlays, cutouts, rotation and theme contrast on the pilot phone. If OS cancellation does not stop sound at the remaining deadline, this sound path needs correction before that runtime gate can pass. API 22–25 lack notification timeout and especially require suspended-process checks. Final production signing, installed version and certificate checks remain with parent integration.

## Isolated Infinix Android 14 test environment

The APK candidate uses `https://apk-api-apk-test.up.railway.app` for both HTTP and Socket.IO. This direct API base has no `/api` suffix: native login requests `/auth/login` and region requests `/districts`. The web service uses its own `/api` Nginx proxy path; dispatcher testing uses `https://apk-web-apk-test.up.railway.app/adminOrders`. Its PostgreSQL service is fresh and separate from development. The final test candidate is reset after verification: only the existing admin and nine canonical regions remain, with no drivers, orders or chat history. New drivers start at zero balance; use synthetic TMT top-ups for testing. No payment integration is enabled. Canonical region polygons are seeded from code without reading the shared database. GPS outside these polygons retains the real position and clears the region.

On the Infinix phone, grant precise location while visible, grant notification permission during the one-time verified-login onboarding, or recover it in Android OS settings, press GPS until the local fix is ready, then Online to submit the fix and acquire the shift. Notification settings do not decide shift eligibility. Check foreground, Home, locked screen and network switching with dispatcher orders/chat. Record private-offer delivery time against its 20-second deadline. Check the phone's app battery settings if XOS stops the shift, without assuming an unverified menu path. Test Offline/logout immediately, and Force Stop followed by a 60-second maximum availability lease. Keep financial data synthetic until the independent financial release gates are closed.

Debug builds use package `io.openride.driver.test` and the visible name `Tayyn Hyzmat Test`, so installing this synthetic environment does not replace a separately signed release app. Release signing and package configuration are unchanged. Test credentials are handed over separately and are never embedded in the APK or public download documentation.

Reverse geocoding is driver-only. A signed-in installation viewing the home-screen location can request one convenience address with fresh precise GPS and internet before a shift, without updating shared tracking. Successful explicit Online requests a fresh address, with one exception to a convenience lookup's cooldown. The visible home-screen location view then refreshes on shift every five minutes without requiring movement. Background views pause; foreground/reconnect makes only one due catch-up. Manual refresh uses the same shared per-driver limit. Persisted markers stop login, relaunch, new devices or repeated Online actions from repeatedly bypassing limits. Dispatcher screens neither request nor display address labels. The daily budget retains 20% reserve and provider backoff; missing configuration or failure shows coordinates without blocking work. The documented quota reset is midnight Moscow time; the isolated API variable readback confirms a 1,000-request daily allocation and a midnight Europe/Moscow reset. An authenticated deployed lookup still needs verification; shared development lookup remains disabled.

## External trip navigation

The trip feed and details offer navigation when the relevant coordinates exist.
Before the passenger boards, the target is pickup. After `Начать поездку`, the
only target is dropoff. If destination coordinates were not supplied, no route
button is shown for a started trip. Call the customer to agree the destination;
the application must not silently route back to pickup. Missing, invalid or
unset `0,0` target coordinates hide navigation, matching the map marker policy.

Android opens the installed Yandex Maps app through an explicit external intent.
If it is unavailable, Android opens the public Yandex web route in a browser.
This handoff needs no geocoder API key. It does not start or finish a trip, end
the shift, or replace the driver WebView. The native shift service continues
subject to the existing GPS and connection lease rules. Return to
Tayyn Hyzmat to mark arrival, start or completion. Completing a trip preserves
an otherwise healthy shift and restores availability for new work.

Test both installed-Yandex and browser-fallback paths on the release phone.
Browser automation verifies route coordinates and the missing-destination rule;
it cannot certify an installed third-party application's routing behavior.

## Firebase setup and rollout

See [Firebase setup and integration](research/firebase-notification-setup.md) and [issue #112](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues/112). The local ignored debug configuration is present, and the sender credential is staged for the isolated Railway `apk-test` backend. The supplied production Android configuration registers `tayyn.hyzmat.production` in that same Firebase project and is staged in the ignored release path. A separate production Admin credential is configured only on the new backend. These files do not establish physical-phone delivery. The API must run the additive notification-installation migration before the matching APK is tested, and production requires a signed build and a real delivery check.

Chat delivery is independent of the shift. Every approved signed-in device can alert with GPS and shift off; the foreground chat is silent, while other screens can display a preview. The app has no notification switch or notification settings control. Recover denied permission and change channel sound in Android OS settings without blocking a shift. Public orders immediately update every eligible driver's queue through Socket.IO, with the initial popup limited to the order's region. FCM is the background alert fallback and never decides claim eligibility or acceptance.

## Account and two-phone verification

With both phones off shift, acquire different local fixes and verify neither changes the dispatcher's retained tracking position. Each installation may perform one foreground convenience address request, subject to the shared driver limit. Reload, reconnect and relaunch must not repeat it. Start on A; its fresh fix and shift must appear together. B can sign in, use chat and view its own local coordinates, but cannot start another shift or change A's reported position. Explicit Offline on A stops uploads even with an assigned trip. The trip stays assigned; B can acquire the shift only after A ends it or its lease expires.

Test Sign out everywhere: all sessions and notification capabilities end, the shift ends, and the assigned trip/password/balance remain. Test temporary Block with a required reason: access ends immediately without cancelling, refunding or reassigning the trip. Unblock requires a new login. Delete account is permanent and blocked while a trip remains unfinished. A new application using its released phone requires approval and starts without the deleted account's balance/history. There is no Reactivate action.

## Address refresh verification

After the one off-shift convenience request, explicitly start a shift and verify one fresh on-shift lookup even if five minutes have not elapsed. Repeated Online actions must not bypass the server limit. Keep the driver location visible for five minutes without moving and verify one automatic refresh. Hide the app through a due interval: no background lookup; returning makes only one due catch-up. Reconnect behaves the same way. There is no dashboard address-refresh button; automatic address refresh shares the five-minute limit across phones. Dispatcher screens never request addresses. Provider failures and missing quota configuration leave coordinates and never affect shift or trip actions.


## Release 1.21 GPS reliability

Dashboard GPS and connection indicators are passive icons with accessible status labels. They have no buttons, tab stops, menus, tooltips, settings shortcuts or explanatory text. GPS is green for a valid fresh local fix, yellow while searching, and red for missing precise permission or disabled location. Connection is green while connected, yellow during the existing reconnect lease and red when offline. Local GPS freshness is independent of cloud acknowledgement. The Online button owns permission/location recovery and retains action-error toasts.

The native bridge and foreground shift service share one acquisition policy. Google Play services location 21.2.0 supplies fused fixes when available. Without GMS, or when fused registration fails, both enabled GPS and network providers are used. Location-enabled detection uses the Android master switch on API 28+, or any enabled non-passive provider on older Android versions. Accept only finite coordinates with reported accuracy at most 100 metres and monotonic age from zero through 60 seconds. A qualifying last-known fix can resolve immediately, while the shift service continues listening for new hardware fixes. Cached points never renew their own age; wall-clock changes do not freshen them.

A visible signed-in driver location view acquires automatically. Each bridge attempt has a finite 90-second cold-start window. Failures retry sequentially after 10, 20 and then at most 30 seconds, without reopening permission dialogs. Hidden off-shift views, explicit Offline and logout cancel acquisition/listeners; session generations reject obsolete callbacks. The native foreground shift continues on-shift acquisition when the WebView is hidden. No off-shift local point is uploaded to driver tracking. Approximate-only permission reports the precise-permission blocker safely and cannot start a shift. The Online action requests precise permission or opens Android's app/location settings as needed.

Automated native checks use Robolectric with real Android LocationManager registration, hardware-provider delivery, monotonic Location timestamps, last-known fixes and listener cleanup. Google Play services is an external boundary in those tests. Browser checks use the real disposable API for shift/session actions and replace only browser/Capacitor location boundaries. Neither suite certifies physical satellite reception, installed GMS behavior, battery restrictions or manufacturer task killing. Verify cold starts, network-only mode, approximate permission, disabled location, foreground/background transitions, screen lock and lease expiry on the release phones. The parent implementation task owns emulator verification; this checkout must not drive the shared emulator.
