# OpenRide Driver — Android

Capacitor-wrapped native shell around a **separate, lean build** of just the driver panel
(`src/main-driver.js` / `src/driver-router.js` / `src/DriverApp.vue`) — not the whole multi-role
web app. See `vue.config.js` (`pages.driver`) and `scripts/prepare-driver-dist.js` for why.

## Rebuilding

```bash
# from the repo root
npm run android:assembleDebug     # unsigned, fast, for testing on a device/emulator
npm run android:assembleRelease   # signed + R8-minified + shrunk resources - the real deliverable
```

Both run the full chain: `vue-cli-service build` → assemble `dist-driver/` (driver-only, no
Vuetify/Firebase/Leaflet) → `npx cap sync android` → Gradle. Output:
`android/app/build/outputs/apk/{debug,release}/app-{debug,release}.apk`.

Needs a JDK 17 + Android SDK (platform 34, build-tools 34.0.0) on `PATH`/`ANDROID_HOME` - this
sandbox has both installed system-wide via `/etc/profile.d/android-sdk.sh`.

## Publishing a release (in-app update check)

`DriverProfile.vue` checks `/apk/latest.json` against its own running version
(`@capacitor/app`) and offers a direct download+install when it's behind - see
`src/services/appVersion.js`. Every real release needs three manual steps, in order (nothing
automates this - there's no CI here):

1. Bump `versionCode` (integer, always +1) and `versionName` (whatever you want shown to
   drivers) in `app/build.gradle`'s `defaultConfig`, then `npm run android:assembleRelease`.
2. Copy the built APK to `/var/www/openride/apk/TayynHyzmat-latest.apk` (overwrite in place -
   the URL in `latest.json` is a stable filename, not versioned).
3. Overwrite `/var/www/openride/apk/latest.json` with the new `versionCode`/`versionName`
   (must match step 1 exactly) and a short `notes` string.

Skipping step 3 (or getting the versionCode wrong) means drivers either never see the update
banner or see it permanently even after updating - `versionCode` is the only thing being
compared, not the filename or `versionName`.

## Release signing

`android/keystore/openride-driver-release.keystore` + `keystore.properties` (both **git-ignored** -
see `.gitignore`) hold the signing key `build.gradle` reads at build time. This specific keystore
was generated in this session as a working placeholder so a real signed APK could ship today.

**Before a real Play Store submission**, generate your own keystore and keep it somewhere durable
outside this sandbox — losing it (or leaving it in a throwaway environment) means every future
update to the listing needs the *same* key; Google can't reissue a lost one for you.
`android/keystore/.keystore-password.txt` has the current password if you want to keep using it.

## Permissions (`AndroidManifest.xml`)

| Permission | Why |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | REST + Socket.IO to the backend |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | GPS while the app is open (Карта, order tracking) - foreground only, via `@capacitor/geolocation`. Used to also run as a background foreground-service (`@capacitor-community/background-geolocation`, `ACCESS_BACKGROUND_LOCATION`/`FOREGROUND_SERVICE`/`FOREGROUND_SERVICE_LOCATION`) - removed after it was the likely cause of a repeatable native crash right after login (see `src/services/geo.js`'s own comment for the full story); position now stops updating once the app is backgrounded |
| `POST_NOTIFICATIONS` | Android 13+ requirement to show local order/chat notifications (`src/services/localNotify.js`) and future real push |
| `WAKE_LOCK`, `com.google.android.c2dm.permission.RECEIVE` | Auto-merged from the push-notifications plugin itself, not hand-added |

**No `CALL_PHONE`**: the client-phone "call" action opens a `tel:` link (`ActiveOrderPanel.vue`),
which Android resolves via `ACTION_DIAL` into the user's own dialer with the number pre-filled -
that needs no permission. `CALL_PHONE` would only be for placing a call directly without the
user confirming in the dialer, which this app deliberately never does.

Verified against the actual compiled release APK with `aapt dump permissions` (see chat) - not just
what's written in the manifest source.

## Optimization applied

- **Speed / size**: a dedicated driver-only web bundle (367 KiB JS vs. ~2.3 MiB for the full
  multi-role SPA), `productionSourceMap: false`, `minifyEnabled true` + R8, `shrinkResources true`.
  Release APK: **1.8 MiB** signed.
- **Security**: R8 obfuscation, no source maps shipped, `network_security_config.xml` blocks
  cleartext HTTP everywhere except `localhost`/`10.0.2.2` (local dev only) and the one real server
  IP below (temporary, until it has a domain + TLS), keystore + password git-ignored, no permission
  requested that isn't used by an actual feature.

## Push notifications - not actually wired to send anything yet

`@capacitor/push-notifications` is installed and the client-side registration flow exists
(`src/services/pushNotifications.js` → `POST /driver/push-token`), but **no push has ever been
sent and none can be until you provide a real Firebase project**: drop its `google-services.json`
into `android/app/`, and implement server-side sending with a Firebase service-account key (nothing
in `backend/` calls FCM's send API today - see `backend/README.md`). The build succeeds without any
of that; it just means the registration call silently no-ops.

## Backend URL for a real device

The APK ships with whatever `VUE_APP_API_URL` / `VUE_APP_SOCKET_URL` were baked in at build time -
now `https://taxi.atajan.org` (real domain, real Let's Encrypt cert, auto-renewing). nginx on that
box reverse-proxies `/auth`, `/driver`, `/orders`, `/admin`, `/districts`, `/health` and `/socket.io`
straight through to the backend on `:4000` (see `/etc/nginx/sites-available/openride` on that
server) - the APK, the web driver panel and the admin panel all now talk to the same HTTPS origin,
no bare-IP/port-4000 access needed any more. The earlier `178.128.222.6:4000` cleartext exception in
`network_security_config.xml` has been removed accordingly - a real domain cert needs no cleartext
exception at all, it's already covered by that file's `<base-config>` system trust-anchors.

Make sure the backend's `CORS_ORIGIN` (see `backend/.env.example`) includes `https://localhost` -
that's the fixed origin Capacitor's Android WebView sends on every request from this APK, unrelated
to `https://taxi.atajan.org` itself; without it every request from the APK gets rejected by CORS
even though the domain itself is reachable fine from a browser.

If the domain/server ever changes again: update `.env`'s `VUE_APP_API_URL` / `VUE_APP_SOCKET_URL`,
add the new cleartext/host exception to `network_security_config.xml` only if it's *not* HTTPS with
a publicly-trusted cert, then `npm run android:assembleRelease` again.
