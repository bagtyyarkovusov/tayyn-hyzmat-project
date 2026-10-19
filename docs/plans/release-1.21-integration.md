# Release 1.21 integration checkpoint

## Candidate ancestry

The local candidate is `feat/release-121-integrated` in the T3 worktree
`t3-81d1129b`. It starts at fetched `origin/main`
`edbc57a2021c486f0c2cf077ad54d3c2b3fdfc2e`.

- GPS `98a00ffd0ab35e363677b03e89679a8f762e45dc` was fast-forwarded.
- Geocoder `82e769643c57790e81e68e7792bbdda492d68b44` was merged with its
  original history in `de40087`. The only conflict was additive English and
  Russian release-note bullets. Both sets were retained.
- Cancellation backend, cancellation UI, GPS follow-up and signup without
  approval still need verified component commits from the parent coordinator.

GPS review of `98a00ff` found two pending P2 issues: region-count refresh after
GPS recovery and a red status that remains after browser permission changes
from denied to granted followed by a timeout. The GPS owner is fixing these
and adding the account-switch standards test. This checkpoint does not mark
GPS ready.

The approved signup handoff adds immediate active self-registration with an
initial session, immediate admin-created accounts and removal of approval
language, queues, counters and actions across driver and dispatcher UI. New
accounts remain offline, without a region and with zero balance. Existing
block/unblock, credential security, GPS and shift requirements remain. The
parent is assigning implementation separately.

No component was cherry-picked. This is a preliminary local candidate, not a
release approval. Reset tooling belongs to a separate task.
The final release goal includes a fresh production reset that preserves one
existing admin identity and password and the exact nine region geometries.
The reset owner handles that work; this checkpoint changes no reset files.

## Narrow driver cleanup

`useDriver.ts` no longer permits `cancel` through `transition`, so the generic
driver transition request cannot target `/orders/cancel`. The cancellation
success notice was removed. No other driver behavior changed. In particular,
`order:cancelled` refresh, cancellation-before-accept-response protection,
notification-event-specific invalidation and GPS session guards remain intact.

The UI component still calls `transition("cancel")` until its stable component
commit removes that control. The preliminary frontend typecheck reports this
single expected error in `ActiveTrip.vue:36`. Do not widen the transition union
to make the intermediate tree compile.

Dependencies were installed with the frozen lockfile and Prisma Client was
generated locally. Backend typecheck passed. Formatting of `useDriver.ts` and
`git diff --check` passed. Full verification is deferred until the component
source is cohesive. Component verification reported by the parent is separate
from verification of this merged tree.

## Integrated verification after component handoff

First merge each stable component commit once, preserve its ancestry, and
resolve product/release wording against the canonical cancellation contract.
Do not change `dispatcher-cancellation-1.21-contract.md` during integration.

Run typecheck, formatting, unit tests and disposable-database integration tests
as required by `CONTRIBUTING.md`. Then run focused real browser regressions
through `pnpm test:e2e` against the real HTTP and Socket.IO server and its new
disposable PostgreSQL container. Use the component's cancellation browser specs
alongside GPS reliability, private/public offer and geocoder coverage.

The integrated checks must observe:

- Acceptance debits the immutable full quote once. Start and completion never
  charge again, and rejected/replayed operations leave the ledger unchanged.
- Drivers have no cancellation control. The compatibility driver cancellation
  endpoint returns 403. Dispatcher cancellation exposes the correct refund
  choice for assigned unfinished stages, with exactly one refund or no refund.
- Unaccepted cancellation shows BEFORE_ACCEPTANCE. Historical NO_DEBIT reports
  refundAmount 0, and ambiguous historical rows remain UNKNOWN.
- Dispatcher cancellation clears the driver's active trip, refreshes balance
  and public region counts through real sockets, and cannot restore a trip from
  a delayed acceptance response. Replays return 409.
- Notification invalidation closes only the matching offer event. Delayed
  responses do not close a newer unrelated offer. Retired review, reoffer and
  final-cancel controls are absent.
- GPS icons stay passive, off-shift fixes never upload, and account switching
  rejects callbacks from the previous session. GPS recovery refreshes region
  counts and permission recovery does not leave a false red status after a
  timeout. A microdistrict house label remains visible without a street and
  geocoder failure preserves coordinates.
- Self-registration opens the driver dashboard with a usable session that
  survives reload, with zero balance, no region and no active shift.
  Admin-created credentials work without replacing the admin session. New
  accounts appear without approval tasks in the admin dashboard, list and
  detail views. Duplicate signup and blocking still protect existing accounts.

For visible manual review, start `pnpm preview:isolated`, use only its ignored
`.local/browser-context.json` URLs and synthetic credentials, and open dispatcher
and driver browser sessions at a mobile viewport. Check the cancellation dialog,
active-trip removal, balance/history labels, GPS status and signup/account UI.
Stop that preview after recording evidence. Browser and native automated
results do not establish physical-phone GPS/GMS behavior.

Signing, publishing, deployment, production reset and merging to main are not
part of this checkpoint.
