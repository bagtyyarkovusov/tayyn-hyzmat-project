# Mobile and APK readiness audit

Audited commit: `c5360cf75fba468adc3027b36c625be041782969`, 2026-10-15.

Verdict: continue isolated browser testing; operational Android release is blocked. This audit changed no runtime code, shared database, Railway configuration or canonical region boundaries.

## Evidence

All 14 existing browser workflows passed in 48.2 seconds against an isolated synthetic database. These cover foreground Chromium behavior. No Android build, native permission dialogs, lock-screen delivery or force-stop behavior was verified.

An independent auditor reproduced four failures through public HTTP against a unique disposable PostgreSQL schema, then dropped the schema. The ignored reproduction script is `.local/audit-concurrency-repro.mjs`.

| Priority | Finding                                                | Evidence and source                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | One driver claims two distinct orders concurrently     | Both requests returned 200; two ACCEPTED orders. `backend/src/modules/orders/orders.service.js:145` checks active orders before driver-level serialization.                                                                                                            |
| P1       | Same cancellation refunds twice                        | Starting at 500 TMT, a 10 TMT acceptance followed by concurrent cancellations returned two 200s, balance 510 and two REFUND rows. `orders.service.js:311`, `order-charge.ts:22`.                                                                                       |
| P1       | Logged-out refresh token creates a new session         | Immediate refresh after logout returned 200. Rotation grace also accepts explicit logout revocation. `backend/src/modules/auth/auth.service.js:202`, `:232`.                                                                                                           |
| P1       | Device binding bypass                                  | Login without deviceId returned 200 for a bound driver. `auth.service.js:123`, `auth.validation.js:25`. Existing access tokens/socket sessions also lack immediate device-revocation enforcement, established by code trace only.                                      |
| P1       | Background availability and push missing               | Browser GPS/timers feed a 60-second freshness window. Native background service and push sender are absent. `src/features/driver/useDriver.ts:205`, `backend/src/modules/driver/gps-eligibility.ts:4`, `backend/src/modules/driver/driver.service.js:309`. Code trace. |
| P2       | Temporary restore failure clears saved login           | Transport errors and server errors clear tokens in `src/features/auth/session.ts:119`. Code trace.                                                                                                                                                                     |
| P2       | Old requests can affect replacement sessions           | Ordinary HTTP retries and driver actions lack session-generation guards. `src/shared/api.ts:112`, `src/features/driver/useDriver.ts:138`, `:161`. Code trace.                                                                                                          |
| P2       | Lifecycle transitions can overwrite concurrent changes | Waiting/start/complete/cancel check status before unconditional updates. `orders.service.js:217`, `:240`, `:270`, `:311`, `:400`. Specific terminal-state races remain unverified at runtime.                                                                          |
| P2       | Notification readiness is invisible                    | Bell ignores permission results and swallows audio/notification errors. `src/features/driver/alerts.ts:7`, `:30`. Browser Notification is not native background push. Code trace.                                                                                      |
| P2       | Native package is not reproducible yet                 | Generated Gradle files reference app/device/geolocation/push plugins absent from package declarations. Default API `/api` and socket window origin need explicit native endpoint configuration. Clean build not attempted.                                             |

## Current availability and persistence

Route navigation preserves GPS. Reload restores the active trip and balance, but resets GPS readiness and explicitly moves an online driver offline until GPS and availability are enabled again. Logout clears local GPS without posting server offline; stale availability can remain for up to the 60-second freshness window. Accepted-trip controls remain usable when GPS expires.

The online ripple represents local online state, fresh GPS and a connected socket/network while the page is visible. It is not proof of background delivery. The bell currently unlocks browser audio and requests browser notification permission, with no reliable readiness feedback. The service worker retires old caches and unregisters itself; it has no push handler. A stored backend push token has no sender.

## Chat refresh and recovery

Driver chat loads on entry, `admin:message` and socket reconnect in `src/features/driver/DriverChat.vue:91`. It also has an always-visible manual refresh button. Dispatcher chat reloads on socket events/reconnect through `src/features/dispatcher/useResource.ts:28`; retry buttons appear on errors. Neither chat implementation explicitly reconciles on foreground return when the socket remains connected.

Normal use should require no refresh button. Keep retry available on a failed recovery. Before removing the driver refresh control, verify automatic recovery for app resume, network restoration, missed events and expired authentication. Preserve drafts, message history position and accepted-trip state during recovery. Driver history currently refetches only the latest 50 messages on reconnect, so more than 50 missed messages can leave a history gap; recover by a stable cursor or fetch missing pages. Dispatcher shows the latest 100 with an explicit limit. These are code-traced coverage gaps, not runtime-proven delivery failures.

Use explicit connection states: connecting, connected, reconnecting, offline and session expired. Keep shift intent separate from server-confirmed availability, GPS freshness, socket connectivity and notification permission. Socket connection alone does not prove data is current. Reconcile authoritative HTTP state after reconnect/resume, then mark data current. Show stale/disconnected state without deleting a valid login. Never silently replay a mutation under a different session.

For APK operation, design a server-owned availability lease renewed by an Android foreground location service while on shift, native push for background offers, and resume reconciliation. Explicit offline/logout revokes the lease immediately. Abrupt force-stop falls back to the documented lease timeout. App removal from recent tasks and Android force-stop must be tested separately. Notification permission as an online prerequisite is still a product decision.

## Pending product behavior

Map hover/tap shows driver information only. Private order assignment with explicit 20-second confirmation remains unimplemented in issue #17. A map action must create the same server reservation as order-form selection; it must not bypass confirmation, expiry or eligibility. Current public claims allow cross-region acceptance immediately; the agreed initial 20-second region window is also pending. Driver cancellation currently allows ACCEPTED and WAITING, which differs from the requested WAITING-only rule and needs reconciliation with issue #11.

## Release gates

1. Fix atomic driver claims, order transitions and idempotent financial operations. Test simultaneous driver/dispatcher actions through public HTTP.
2. Fix logout/device revocation and stale request isolation. Test delayed responses, account switching and temporary restore failures.
3. Implement connection recovery and notification readiness. Test chat catch-up beyond one page, resume without socket reconnect, offline drafts and lost mutation responses without duplicate sends.
4. Make clean native builds reproducible with declared plugins, explicit HTTPS endpoints and appropriate backend origin configuration.
5. Implement background shift service, native push and bounded availability lease. Prove behavior on Android before release.
6. Implement private offers and regional timing as separate product changes with isolated lifecycle tests.

Real-phone acceptance must cover permission grant/deny/revoke, screen lock, backgrounding, recent-task dismissal, force-stop, battery saver, network loss/switch/recovery, process death, offline launch, token expiry, device replacement, offer expiry while suspended, competing claims and restart during an active trip. Verify sound stops on acceptance, notifications do not expose customer phone before acceptance, and server state matches driver/dispatcher after recovery. An emulator alone cannot establish manufacturer battery-management behavior.

## Tracked work

- [Atomic orders and refunds #22](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues/22)
- [Logout and device revocation #23](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues/23)
- [Session recovery and pending requests #24](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues/24)
- [Live chat and state recovery #25](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues/25)
- [Android release readiness #26](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues/26)
- [Private offers #17](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues/17)
