# Pilot release evidence, 16 October 2026

This record separates code review and automated checks from device and deployment evidence. A merged PR does not prove that an older installed APK contains its changes.

## Confirmed integrations

| Change | Repository evidence | Verification limit |
| --- | --- | --- |
| Offer dialog with one surface and larger price | PR #76 | Mobile/browser checks; rebuild APK for later code |
| Funded acceptance and no negative balance | PR #77, `e3efdc5` | API/socket/browser checks; synthetic TMT only |
| Compact monitoring roster | PR #78 | Search, filtering, mobile sheet, >100-driver loading, local GPS patching |
| Dispatcher resolution of stuck started trips | PR #80, `e821397` | 15-minute warning, explicit force-complete with reason and audit, no timer completion |
| Standalone driver authentication shell | Commit `7f30911`, integrated through PR #81 | Same file changes as PR #82; #82 closed as duplicate after independent review |
| Bilingual operating guides | PR #83, `63db29d` | English/Russian explanation and Mermaid diagrams |
| Saved regions in monitoring filters | PR #84, `9460ca6` | Independent review and all CI jobs passed; deployment verification recorded separately |
| Canonical busy-driver availability | PR #94, `b21b4d0` | All CI jobs passed; active ACCEPTED, WAITING and STARTED trips override stale availability in API, monitoring and region counts |
| Compact driver trip feed | PR #95, `0de8ae8` | All CI jobs passed; short portrait and landscape layouts retain price, call and next-trip controls |
| Shared server-side address budget | PR #68, `cf8bf84` | Optional lookup, source-age-aware cache, quota controls and fallback merged; provider activation and live checks remain separate |
| Concurrent trip force-resolution lock order | PR #90, `0ba709d` | Full CI green and two independent reviews; driver → order locking matches completion/cancellation |
| Chat recovery and safe send retries | PR #87, `2935991` | Full CI green and independent review; composite read/page cursors, retry idempotency and tied-timestamp tests |

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

- PR #67 adds the Ashgabat created-today cohort and all-date live waiting measurements. Rebased head `eebfcc2` preserves merged balance and trip-resolution work. Typecheck, five unit tests, formatting, and modern build passed locally. Full integration/browser verification depends on CI because local Docker was unavailable. Rebased head `fe59566` excludes stopped private orders from live waiting while preserving held regional public orders as waiting and stopped orders in the created-today cohort. The regression failed with 3 public orders instead of 1 before the correction. All 103 HTTP/Socket/geocoder tests pass on disposable loopback PostgreSQL 18 and the focused Today browser check passes. Standard Docker PostgreSQL 17 CI remains the merge gate.
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

Balance adjustment `operationId` is required. Old dispatcher tabs must refresh; a missing operation ID returns 400 rather than accepting an unguarded adjustment. Retries must not duplicate credits or withdrawals. Account removal soft-deactivates while preserving ledger and order history. Confirmed issues #39, #40 and #41 remain production blockers until the separate reviewed fixes merge and pass CI. These decisions must not be changed back to optional IDs during integration.

## Client guide exports

The English and Russian standalone HTML/PDF tutorials include rendered flow diagrams, dispatcher and driver walkthroughs and pilot limits. They contain no credentials or internal record IDs. Export files are under `docs/guide/export/`; the release copies are also available under `output/release-guide/` in the project workspace.
