# Android notifications without Firebase

Researched 2026-10-15 against the primary sources below. This is an architecture comparison, not an implementation or a native-device test result.

## Requirement

Drivers stay available while on shift with the screen locked or the app in the background. Explicit offline and logout end availability immediately. Force-closing ends availability, with a bounded server lease because abrupt termination may provide no callback. See [product scope](../product.md).

## Answer and recommendation

A Firebase-free Android APK is possible. Packaging the existing web app as an APK does not add background delivery. We need native Android execution, notification handling, and an authenticated server delivery path.

If avoiding Google infrastructure is a firm requirement, first prototype an on-shift native location foreground service with an authenticated persistent connection to our backend and native notifications. Start it when the driver enables availability while the app is visible. Stop it on offline/logout. Keep delivery and shift eligibility separate, with server leases and fresh location checks.

This suits a single driver APK without another app to install. It also makes us responsible for reconnection, power management, device-specific restrictions and delivery measurements. A foreground service is not a guarantee of uninterrupted networking during Doze. Android documents network suspension in Doze and a separate partial battery-optimization exemption that allows networking and partial wake locks. Exemption does not remove every restriction. [1]

Do not promise that a 20-second private offer will always arrive in time. The server must enforce its expiry, and the client must discard expired offers after waking or reconnecting. Real phone tests must establish whether this architecture meets the pilot's latency and battery requirements.

## Options

| Option                                              | What it requires                                                                                                                       | Tradeoff for this project                                                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native shift service plus our persistent connection | Android location foreground service, notification channels, authenticated TLS connection, reconnect/replay, server availability lease  | One APK and our own infrastructure. More native engineering and battery/device testing. Socket.IO, WebSocket or MQTT changes the transport, not Android power restrictions. |
| UnifiedPush with self-hosted ntfy                   | Native UnifiedPush integration in our APK, a compatible distributor such as ntfy installed on the phone, self-hosted HTTPS push server | Reuses an existing push ecosystem. Adds driver onboarding and a second app/service to configure and support. Still needs our own location/availability solution. [4][5]     |
| FCM only for notifications                          | Firebase project and native FCM registration; our backend sends notifications                                                          | Does not require moving our database, authentication or hosting to Firebase. FCM documents sending from an independent app server. It remains a Google dependency. [6]      |

The ntfy Android documentation says its self-hosted subscriptions do not use Firebase. Its F-Droid build includes no Firebase and enables its persistent delivery mode for all subscriptions. The documentation describes that mode as a foreground service with an ongoing notification. Treat those delivery claims as product documentation, not a measured guarantee on our drivers' phones. [5]

FCM is an alternative if the concern is avoiding a Firebase backend rather than avoiding Google delivery infrastructure entirely. Our current API, PostgreSQL and Railway/VPS deployment can remain independent. [6]

## Android constraints

- A location foreground service must declare the location service type and its applicable permission, and the app needs enabled location services and coarse or fine location permission. Android restricts creating it from the background; `ACCESS_BACKGROUND_LOCATION` is relevant to background creation, rather than a blanket requirement for every service started while the app is visible. Design the shift start around the visible Online action. [2]
- A foreground service supports ongoing, user-visible work. Do not label an unrelated permanent socket as a location service just to evade restrictions. Our legitimate ongoing work is driver location sharing while on shift. Android warns against starting foreground services merely to avoid app idleness. [1][2]
- Doze can suspend networking and ignore ordinary wake locks. Changing from WebSocket to MQTT does not itself fix this. Periodic jobs or alarms are not a timely substitute for a 20-second offer. Android limits idle-allowed alarms and defers ordinary jobs. [1]
- Android notification permission and channel settings must be exposed in the app with actionable feedback. A functioning transport does not prove that a driver can hear or see a notification. Native permission and channel behavior require device tests. [7]

## What closing means

| Action                                   | Required application behavior                                                                                                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home button, another app, or lock screen | Keep the shift service, location reports and delivery running while eligible.                                                                                                                                                     |
| Offline or logout                        | Revoke availability on the server, stop native delivery for the shift, and clear pending order alerts.                                                                                                                            |
| Swipe away from Recent apps              | This is task removal, not necessarily Android Force Stop. Choose and implement whether it ends the shift. Android services expose `onTaskRemoved`; `FLAG_STOP_WITH_TASK` stops the service instead of invoking that callback. [8] |
| Android Active apps Stop                 | Android stops the entire app and sends no app callback. Server lease expiry is necessary. [3]                                                                                                                                     |
| Settings Force Stop                      | The app enters the stopped state. Do not design push or service restart as a way to bypass that user choice. Android documents remaining stopped until user interaction removes the state. [9]                                    |
| Process kill or connection loss          | Reconcile from the server on recovery. Availability must expire within the agreed lease timeout when its renewal stops.                                                                                                           |

No client can guarantee an immediate offline request after every abrupt termination. The lease duration is the documented upper bound for stale availability, not an assertion that the server can identify the exact reason for disappearance.

## Proposed implementation boundaries

These are design proposals, not existing behavior or settled timeout values.

1. The backend owns shift availability, eligibility, order ownership, offer deadlines and a bounded renewable lease. Recheck eligibility when sending and accepting an order.
2. A native Capacitor bridge owns shift start/stop, location updates, connection lifecycle, native notification permissions and notifications. The WebView reads its status rather than owning background execution.
3. Persist notification events with stable IDs and bounded retention. Reconnect resumes from a cursor, fetches canonical state and deduplicates events. Never replay an expired private offer as actionable.
4. Push transports event IDs and minimal content. Fetch authorized details from the API. Keep customer phone information hidden before order acceptance, including on the lock screen.
5. Chat and orders use separate notification channels. Opening a chat, accepting an order, logout and expiry clear the appropriate alert without deleting unrelated alerts.
6. Display server-confirmed availability and a separate degraded connection state. A green animation must not claim live connectivity merely because a local switch remains on.

## Release evidence needed

Test real intended driver phones, including the local mobile networks. Cover screen locked for extended periods, stationary Doze, battery saver, permissions denied/revoked, manufacturer battery restrictions, Wi-Fi/mobile switching, lost internet, task swipe, Active apps Stop, Settings Force Stop, logout, expired offers and duplicate event delivery. Measure notification latency and battery use. Test chat arrival separately from order delivery and verify no stale account notifications after switching accounts.

This research did not build or install an APK, simulate Doze, or establish delivery latency in Turkmenistan. Backend hosting alone cannot establish phone-side reliability.

## Sources

1. Android, [Optimize for Doze and App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby). Network restrictions, partial exemptions, alarm limits and FCM guidance.
2. Android, [Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types). Location use cases, permissions and background creation restrictions.
3. Android, [Handle user stopping an app that has a foreground service](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping). Active apps Stop removes the whole app and provides no callback.
4. UnifiedPush, [Distributors](https://unifiedpush.org/users/distributors/). Distributor apps and self-hosted push server choices.
5. ntfy, [Subscribe from your phone](https://docs.ntfy.sh/subscribe/phone/). Firebase-free self-hosted subscriptions, F-Droid behavior, persistent service and UnifiedPush distributor integration.
6. Firebase, [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging). Independent trusted app server and platform client architecture.
7. Android, [Notification runtime permission](https://developer.android.com/develop/ui/views/notifications/notification-permission). Android 13 notification permission and foreground service notification behavior.
8. Android, [Service API, onTaskRemoved](<https://developer.android.com/reference/android/app/Service#onTaskRemoved(android.content.Intent)>). Task removal callback and stop-with-task flag.
9. Android, [Android 15 behavior changes, package stopped state](https://developer.android.com/about/versions/15/behavior-changes-all#stopped-state). Force-stop intent and restart behavior.
