# Pilot release evidence, 16 October 2026

This record separates code review and automated checks from device and deployment evidence. A merged PR does not prove that an older installed APK contains its changes.

## Confirmed integrations

| Change                                         | Repository evidence                         | Verification limit                                                                                                               |
| ---------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Offer dialog with one surface and larger price | PR #76                                      | Mobile/browser checks; rebuild APK for later code                                                                                |
| Funded acceptance and no negative balance      | PR #77, `e3efdc5`                           | API/socket/browser checks; synthetic TMT only                                                                                    |
| Compact monitoring roster                      | PR #78                                      | Search, filtering, mobile sheet, >100-driver loading, local GPS patching                                                         |
| Dispatcher resolution of stuck started trips   | PR #80, `e821397`                           | 15-minute warning, explicit force-complete with reason and audit, no timer completion                                            |
| Standalone driver authentication shell         | Commit `7f30911`, integrated through PR #81 | Same file changes as PR #82; #82 closed as duplicate after independent review                                                    |
| Bilingual operating guides                     | PR #83, `63db29d`                           | English/Russian explanation and Mermaid diagrams                                                                                 |
| Saved regions in monitoring filters            | PR #84, `9460ca6`                           | Independent review and all CI jobs passed; deployment verification recorded separately                                           |
| Canonical busy-driver availability             | PR #94, `b21b4d0`                           | All CI jobs passed; active ACCEPTED, WAITING and STARTED trips override stale availability in API, monitoring and region counts  |
| Compact driver trip feed                       | PR #95, `0de8ae8`                           | All CI jobs passed; short portrait and landscape layouts retain price, call and next-trip controls                               |
| Shared server-side address budget              | PR #68, `cf8bf84`                           | Optional lookup, source-age-aware cache, quota controls and fallback merged; provider activation and live checks remain separate |
| Concurrent trip force-resolution lock order    | PR #90, `0ba709d`                           | Full CI green and two independent reviews; driver → order locking matches completion/cancellation                                |
| Chat recovery and safe send retries            | PR #87, `2935991`                           | Full CI green and independent review; composite read/page cursors, retry idempotency and tied-timestamp tests                    |

## Integrated workflow decisions

### Driver readiness, PR #85, merged `2095f56`

Local location permission/fix, network connection, successful location upload, and online shift are separate facts. Green combined readiness requires a fresh GPS fix and a confirmed dispatcher connection. Amber means acquiring or reconnecting; red identifies location permission/system-location failure. An offline driver retains a timestamped last location, which cannot count as live supply or eligibility.

Explicit Online must get a server acknowledgement before accepting work. Offline stops recurring GPS uploads. Accepted trips remain assigned during disconnection. Address lookup never blocks the shift. Native permission changes must be reconciled when the app returns to the foreground. A green indicator must not survive a revoked permission simply because an earlier fix is younger than 60 seconds.

Review at head `3570961` confirms that the fast green path skips a duplicate preflight upload and foreground return invalidates readiness after revoked Android permission. Focused browser regressions cover both. The follow-up `133e72a` adds a separate native system-GPS-enabled signal and gates foreground return, preflight, explicit GPS, and native startup. Two additional regressions cover system GPS off independently of permission. The reviewed contract has no remaining code-review blocker; CI passed and the PR is merged; physical device checks remain separate. No new financial or assignment corruption was found in the reviewed change.

### Release audience, PR #79, merged `715b648`

A private reservation lasts exactly 20 seconds. The dispatcher chooses whether expiry stops the order or makes it public to all eligible regions at once. Global opening has no second acceptance timer. The first valid claim wins, and all clients must remove the order.

Code review at head `03cd718` found that the reported audience gaps are fixed. Persisted regional deadlines, global-release markers, and stopped markers govern queue reads, atomic acceptance, native inbox recovery, Socket.IO publication, and removal. Customer phones stay hidden before acceptance and funded acceptance remains in force. The migration preserves existing public orders' availability. The order's original district remains unchanged when its audience expands. CI passed and the PR is merged. Deployment verification is separate.

The reviewed implementation holds a new public order in its original region for 20 seconds, then opens it globally. An early private decline returns it to the original region until the original deadline; at that deadline the dispatcher's expansion choice determines global release or stop. The merged API enforces this audience policy; installed APK and deployment checks remain separate.

## Other follow-ups

- PR #67 adds the Ashgabat created-today cohort and all-date live waiting measurements. Rebased head `eebfcc2` preserves merged balance and trip-resolution work. Typecheck, five unit tests, formatting, and modern build passed locally. Full integration/browser verification depends on CI because local Docker was unavailable. Rebased head `fe59566` excludes stopped private orders from live waiting while preserving held regional public orders as waiting and stopped orders in the created-today cohort. The regression failed with 3 public orders instead of 1 before the correction. All 103 HTTP/Socket/geocoder tests pass on disposable loopback PostgreSQL 18 and the focused Today browser check passes. Final rebased head `2e07c0e` passed all three CI jobs, including the standard Docker PostgreSQL 17 integration suite, and #67 is merged.
- PR #68 is merged as `cf8bf84`. Optional Yandex lookup uses a shared server budget and keeps the original resolution time when reusing cached addresses. Driver eligibility still depends on GPS and saved regions. It retains the unique Yandex setup research from the superseded PR #50. Provider key, confirmed quota, reset timezone, retention policy, and live provider checks remain separate from code correctness.
- PR #87 addresses older-message pagination, read-cursor safety, background read visibility, and duplicate sends. Independent review of `7544706` and test isolation follow-up `79445bd` found no remaining blocker: reads and pagination use composite `(sentAt,id)` cursors, including native inbox recovery, with tied-timestamp regressions. The final integration is `2935991`, with full CI green and independent review. The earlier index concern was withdrawn.
- GitHub hygiene closed superseded PRs #50, #55, and #82 without merging older snapshots. Active follow-ups remain open.

## Android release gate

The emulator evidence covers installation, login, simulated GPS, online/offline, public/private offers, the private countdown, competing claims, charges/refunds, trip transitions, and offer modal rendering. That evidence does not establish background reliability on the target phone.

Before a production release, test a newly built APK against its matching API on the Infinix Android 14 phone:

1. Accept and deny precise location and notification permissions. Disable system location, revoke a permission in Settings, return to the app, and verify indicators plus Online gating.
2. Start a shift, switch Home, lock the screen, and send both public/private orders and chat. Record delivery latency against the 20-second server deadline.
3. Keep the phone stationary for at least 30 minutes under Doze, battery saver, and normal manufacturer settings. Record missed or delayed events and battery cost.
4. Switch Wi-Fi/mobile data and lose all network for more than 60 seconds. Confirm the server marks the driver unavailable, map data is stale, and accepted trips remain assigned.
5. Test Offline, logout, task swipe, process kill, Android Stop, Force Stop, and reboot. No unwanted shift restart or old-account notification may occur.
6. Accept, decline, expire, and lose a claim race. Verify the sound stops, notifications clear, customer phone privacy holds, and the charge/refund is exactly once.
7. Verify release signing, package identity, server URLs, fresh APK version, and an install/update path. A browser deployment alone does not replace bundled APK assets.

Keep screenshots, APK version/hash, API commit, phone model/OS, and observed results with the test record. Until those checks pass, describe this as a test APK rather than a production-certified release.

## Finance decisions retained for release

Balance adjustment `operationId` is required. Old dispatcher tabs must refresh; a missing operation ID returns 400 rather than accepting an unguarded adjustment. Retries must not duplicate credits or withdrawals. Account removal soft-deactivates while preserving ledger and order history. PR #99 merged as `5d51e2e` after review and CI, guarding representable TMT amounts and preserving room for refunds. PR #100 merged as `41cba82` after review and CI, soft-deactivating accounts while preserving balances, ledger and orders. Required-operation-ID adjustment idempotency in PR #101 merged as `4ddd880` after review and green CI. These decisions must not be changed back to optional IDs during integration.

## Client guide exports

The English and Russian standalone HTML/PDF tutorials include rendered flow diagrams, dispatcher and driver walkthroughs and pilot limits. They contain no credentials or internal record IDs. Export files are under `docs/guide/export/`; the release copies are also available under `output/release-guide/` in the project workspace.

## Requirement-to-evidence checklist

| Requirement                            | Code and automated evidence                                                                                      | Release evidence still needed                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Saved regions survive new environments | Canonical region fixture and isolated seed; no geometry changes in this batch                                    | Compare deployed region list with approved saved boundaries                        |
| Only one driver accepts an order       | Locked public/private acceptance, conditional assignment and competing-claim regressions                         | Two physical phones claiming at the same time                                      |
| One charge and one allowed refund      | Charge ledger, funded-acceptance and terminal-race integration tests                                             | Check visible balance and ledger in fresh APK against matching API                 |
| Busy driver never offered second work  | #94 HTTP/socket tests for ACCEPTED, WAITING, STARTED and delayed monitoring snapshot regression                  | Dispatcher map/roster while phone reconnects during trip                           |
| Private 20-second expiry ON/OFF        | #79 persisted deadline, queue/claim/inbox/socket tests                                                           | Locked-screen countdown and delivery latency on Infinix                            |
| GPS and address fallback are separate  | #85 readiness and #68 budget tests with external-provider fixture                                                | Actual Android GPS permission/settings changes and live Yandex activation          |
| Live chat and reconnect                | #87 composite cursors and retry identity tests                                                                   | Wi-Fi/mobile loss and locked-screen chat delivery                                  |
| Started trip resolution is recorded    | #80 reason-required completion, #90 lock-order races and #105 STARTED cancellation rejection                     | Dispatcher resolves a real test trip, driver sees completion without another debit |
| Compact order form and optional map    | #103 desktop/mobile/landscape API-backed browser tests                                                           | Soft keyboard and real map SDK on target phone                                     |
| Honest daily measurements              | #67 Ashgabat cohort, live waiting, missing samples, p90 and empty/failure checks                                 | Compare dashboard with a small recorded test day                                   |
| No duplicate balance adjustment        | #101 merged `4ddd880`; required-ID HTTP tests cover concurrent/mismatched replay, rollback and uncertain retries | Fresh dashboard retry and old-tab refresh checks                                   |
| Release binary matches service         | Build and Android unit CI checks                                                                                 | Signed APK version/hash/API commit and successful physical install/update          |

## Native endpoint contract

The isolated APK API is a direct backend, so its base URL is `https://apk-api-apk-test.up.railway.app`, without `/api`. Native requests append paths such as `/auth/login` and `/districts`. The direct backend does not expose `/api/auth/login`. The web service uses `/api` as its Nginx proxy path; that web proxy convention must not be copied onto the direct native API base. Socket.IO uses the direct backend origin too. Record the actual build-time endpoint values with the APK hash and matching API commit.

## GPS architecture audit limits

- Foreground browser GPS uses `watchPosition`, throttles successful server uploads to at most one per 10 seconds, and checks freshness on a 10-second timer. Driver GPS expires after 60 seconds. A green local fix does not prove the dispatcher received it.
- Android requests location updates at a nominal 10-second cadence and checks its canonical order/chat inbox on shift. Lease renewal requires a hardware fix no older than 30 seconds; the server lease lasts 60 seconds and cannot be revived after expiry. These are requested intervals, not guarantees under Doze or manufacturer battery restrictions.
- Each accepted browser/native location report updates the current position and appends `DriverLocation` history. The existing `(driverId, recordedAt)` index supports per-driver chronology. History currently has no bounded retention or scheduled pruning. Agree retention, estimate storage at the expected shift cadence, and verify history queries/indexes before wider rollout. Deferred GPS retention/query work is tracked in [#106](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues/106).
- Browser REST location persistence has no durable outbox for its Socket.IO publication. A saved update may not reach an already-open dispatcher screen if publication fails; roster reconciliation on reconnect, foreground return and its periodic read repairs that view. A durable publication/replay design remains an operational follow-up, not implemented proof; live recovery follow-ups remain tracked in [#25](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues/25).
- Locked/background Android delivery requires the native foreground service. Browser timers, browser GPS and Socket.IO alone cannot meet that requirement. Target-phone permission, network loss, Doze, battery, locked-screen latency and shift-termination checks remain release gates.
- Reverse address lookup is separate from GPS reporting and region matching. Its five-minute/150-metre gate, fleet cap and coordinates fallback do not slow location reporting or block trip controls.

## Latest code integration

PR #105 merged as `fd10bc86457fd9292565ad5a727aa2a9142e90de` after all three CI jobs passed. It removes dispatcher cancellation of STARTED trips in both UI and API, including stale-client requests. Driver cancellation remains WAITING-only, enforced by merged PR #97. A dispatcher can cancel NEW, ACCEPTED or WAITING, which refunds a recorded debit once. A STARTED trip can instead be completed manually with a required reason, preserving its charge and recording the dispatcher. Exceptional refunds are not part of ordinary cancellation.

PR #103 enlarged the optional order map beside the form on wide screens and stacks it below on narrow screens. Required region, phone and TMT price, private eligibility and optional pickup/destination remain unchanged. API-backed browser evidence covers desktop, mobile and landscape; live vendor SDK behavior and phone keyboard checks remain separate.

PR #107 merged as `2eb84649901e70aaae3feb1d1a188f8d71ef5db4` after all CI jobs passed. It closes the session and device-binding gaps tracked in #23 and #24: driver device identity is required, password/reset races are serialized, logout revokes the current credential generation and sockets, and transient restore failures keep credentials behind a retry screen. The final APK must still be rebuilt from this mainline and tested on the target phone.

## Current isolated APK environment

The isolated APK API has no configured private Yandex reverse-geocoder key or confirmed lookup-budget policy. Its expected location display is the saved region plus actual coordinates, or Outside region plus coordinates. This is the approved fallback and never blocks a shift or trip. It is not evidence that the provider is broken. A public map SDK key is a different credential; native map rendering is verified separately in the final APK build record.

The client tutorials contain eight A4 pages per language. Both tagged PDFs were rendered to page images and all sixteen pages inspected. The lifecycle explanation has its own page so cancellation/refund and completion/no-refund are readable without squeezing monitoring instructions. The HTML files embed the logo and use local diagrams; opening them does not require a diagram service. Production signing and physical Infinix checks remain explicit gates in both languages.
