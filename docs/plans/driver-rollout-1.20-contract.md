# Release 1.20 backend contract

Implementation contract for approved issue #131, 2026-10-18. Backend branch `t3/driver-rollout-backend-1-20`, based on `0bc68d8`. This file is available before implementation so web and Android can integrate against stable names.

## Funding

Existing driver order endpoints stay unchanged: `POST /api/orders/accept`, `/waiting`, `/start`, `/complete`, `/cancel`, with `orderId`. Cancel needs no reason and accepts only ACCEPTED. WAITING and STARTED cancellation return 409. Accept holds the quote; waiting does not charge; start captures once. Driver `/balance.amount` stays total. Admin driver list/detail `user.balance`, history `balance`, and adjustment response `balance` add decimal strings `total`, `held`, `available`, preserving `amount` and `currency`. `balance:updated` adds those fields; hold/release use reasons `HOLD` / `RELEASE`, capture uses `PAYMENT`. No PAYMENT or REFUND ledger entry is created for hold/release.

## Cancellation review

Order payloads add `cancellationReviewRequired: boolean`, `offerAttemptId: string`, `notificationEventId: string`. Existing `order:cancelled` admin event includes full order number, assigned `driverId` and `driver.user.{fullName,phone}`, plus the persisted review flag. Reconnect/banner recovery: `GET /api/admin/orders/cancellation-review?page=1&limit=20` returns `{items,total,page,limit}`, only action-required cancellations. Existing `GET /api/admin/orders?status=cancelled` puts review-required orders first before pagination, then newest cancellation timestamp and UUID. `GET /api/admin/orders` rows expose the same flag, `resolutionActions: ['REOFFER','FINAL_CANCEL']` for unresolved items and `[]` otherwise, and `assignments` with past drivers/quotes/timestamps.

`POST /api/admin/orders/:id/reoffer` with `{}` reopens only review-required CANCELLED work, retaining UUID, orderNumber, original district and details. Returns full NEW order with cleared assignment/lifecycle fields, fresh 20-second public window and new attempt identity. `POST /api/admin/orders/:id/final-cancel` with `{}` makes a review-required cancellation terminal. Stale/duplicate resolution returns 409 and does not add an attempt/audit. Ordinary admin `/cancel` accepts NEW, ACCEPTED and WAITING, remains terminal, and now records its actor. `order:reoffered` and `order:cancellation-resolved` inform admin refresh; existing `order:new`, `order:available` and `order:taken` keep their roles. Review API and flags are durable banner truth.

## Notification identity

Use server-supplied `notificationEventId`, never construct `order:<id>`. Public identity is `order:<orderId>:<offerAttemptId>`; private identity is `private:<orderId>:<offerAttemptId>`. `GET /api/driver/notifications/inbox` returns `{events,serverTime}` as an authoritative snapshot of current order alerts. Each canonical order event includes `{id,orderId,offerAttemptId,expiresAt,serverTime,order}`; `order` is the full safe offer without clientPhone. HTTP offer payloads also include `expiresAt` and `serverTime`. A failed inbox request must not reconcile an empty set. Exact invalidation payloads on `order:taken` and `order:private-offer-ended` include `{orderId,offerAttemptId,notificationEventId,eventId}`. Full cancelled payloads include `notificationEventId` and `offerAttemptId`.

`offerAttemptId` is an opaque server-owned UUID, replaced on each new public reoffer or private reservation. HTTP available/private/current/admin orders and offer sockets include both fields. Canonical `notification:event`, native lease tick and FCM use that exact identity. Canonical events add `offerAttemptId`. Old attempt verification returns null even if the same order is offered again. Deduplicate and invalidate by full event ID, while routing/actions continue to use order UUID. Popup expiry is still the persisted public/private deadline.

## Chat

`GET /api/admin/messages/broadcasts?page=1&limit=30&beforeMessageId=<uuid>` returns `{items,total,page,limit}`, chronological items within each newest-first page, only admin-authored broadcasts. Existing admin `/drivers/:id/messages` now chronologically merges that driver's private thread with broadcasts sent since their user account creation. Rows preserve `isBroadcast`; use it to label broadcasts. Driver history/unread/read/native canonical recovery apply the same creation cutoff. Private driver replies remain visible only to that driver and admins. Existing send/read/socket contracts stay intact. Notification compatibility fields always report enabled; historical mute values and old enabled=false requests no longer suppress delivery.

## Compatibility and isolation

Old already-paid assigned trips retain their actual debit; starting cannot debit again, and pre-start admin/driver cancellation refunds the historical debit once. New accepted quotes are snapshotted in assignment history. All writes use driver, order, wallet lock order. Schema changes are additive; no migration resets data. Only disposable PostgreSQL tests run here; production reset belongs to operations.

## Backend verification, 2026-10-18

Implementation commits are `b7597d19a1ffaf6a822f2e9c6e2fcfd2ac5ceba4` and `688bc785e6834fd0fa6198230bf125db77672f2d`, based on `0bc68d8`. The second commit delivers driver cancellation to every signed-in driver installation as well as admins.

- `pnpm --filter openride-backend typecheck` passed, including backend build and test types.
- `pnpm --filter openride-backend test:unit` passed all 7 tests.
- `pnpm --filter openride-backend test:integration` passed all 177 tests with no skips in 114.75 seconds. The repository runner applied all migrations to a fresh PostgreSQL 17 container, then removed only that container and its disposable storage.
- `pnpm format:check` and `git diff --check` passed. No build tooling or Docker startup files changed.

The initial funding regression failed against `0bc68d8`: accepting 40 TMT reduced a 500 balance to 460 when 500 was required. The cancellation socket regression failed with `Missing order:cancelled` before the driver-room fix, then passed for both the initiating installation and a second installation. The final full run includes both regressions.

HTTP/Socket tests cover quote snapshots, exact funds, held-fund withdrawal/adjustment protection, competing accept/arrive/start/cancel requests, capture rollback after a ledger failure, duplicate resolutions, priority before pagination, same-order reoffer, old versus new canonical identities, inbox recovery, FCM fallback identity, preserved driver/quote history, legacy already-paid ACCEPTED/WAITING/STARTED trips, and broadcast cutoff/private-reply isolation. Old tests requiring acceptance debits, refunds for holds, WAITING driver cancellation or muting were intentionally updated to the approved behavior.

No shared or production data was read or changed by fixtures/tests. This is backend verification, not evidence of production rollout or physical-phone delivery. FCM HTTP is the external test seam; authenticated application HTTP, sockets, order transactions and PostgreSQL are real. Host storage was low during this work; no shared Docker resources were pruned.
