# Dispatcher cancellation and immediate debit contract, 1.21

## HTTP lifecycle

| Request                                                                                                             | Result                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /orders/accept {orderId,...}`                                                                                 | Atomically assigns the order and debits the full immutable quoted fare once. Insufficient available funds returns 403 without an assignment, ledger entry or committed notification. Existing device/offer validation remains required. |
| `POST /orders/start` and `POST /orders/complete`                                                                    | Never debit. They retain the accepted quote and existing lifecycle/device checks.                                                                                                                                                       |
| `POST /orders/cancel`                                                                                               | Retained for old clients, always 403 for approved authenticated drivers, before body validation or order lookup. No driver reason/request flow.                                                                                         |
| `POST /admin/orders/:id/cancel {}` for NEW                                                                          | Cancels with `BEFORE_ACCEPTANCE`, refund amount 0 and no ledger write.                                                                                                                                                                  |
| Same admin endpoint with `{outcome:"WITH_REFUND"}` or `{outcome:"WITHOUT_REFUND"}` for ACCEPTED, WAITING or STARTED | Requires ADMIN. Returns the selected outcome when an original debit is proven, refunds it once or retains it, and frees the driver atomically. No reason is required.                                                                   |
| Assigned admin cancellation without a valid explicit outcome                                                        | 400. There is no financial default for old admin clients.                                                                                                                                                                               |
| Cancellation of COMPLETED or CANCELLED                                                                              | 409, including repeat same-outcome requests. No additional ledger row or refund.                                                                                                                                                        |
| Cancellation with ambiguous assignment/ledger coverage                                                              | 409 with `LEGACY_FUNDING_AMBIGUOUS` in error details, including an assigned status without a driver or NEW with a driver; no money, order, driver or notification changes.                                                              |

Acceptance retries retain existing claim conflict semantics, including 409 for an already assigned order; they never debit twice. If acceptance wins a race against a NEW cancellation read, cancellation returns 409 for changed assignment and must be resubmitted with an explicit outcome. If cancellation wins, acceptance cannot resurrect the order. Cancellation races with Start or completion preserve a single valid locked transition. Completed orders remain closed.

## Additive payload and events

Existing order IDs, status strings and event names remain stable. Orders add `cancellationOutcome`, `cancelledBy` and `cancellationRefundAmount`, with existing `cancelledAt`:

| Outcome             | Meaning                                                                               | Refund amount                                 |
| ------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| `WITH_REFUND`       | Proven original debit returned                                                        | Exact original debit, decimal string          |
| `WITHOUT_REFUND`    | Proven original debit retained                                                        | `"0"`                                         |
| `BEFORE_ACCEPTANCE` | Cancelled NEW order                                                                   | `"0"`                                         |
| `NO_DEBIT`          | Legacy unpriced accepted order had no debit, regardless of requested financial action | `"0"`                                         |
| `UNKNOWN`           | Historical cancelled row lacks a provable recorded outcome                            | `null` unless an amount was actually recorded |
| `null`              | Not cancelled                                                                         | `null`                                        |

For a new quoted order with fare 40, acceptance changes wallet 500 to 460 with one PAYMENT of -40. Editing current order price to 99 cannot change that quote. With refund returns 40 and wallet 500; without refund leaves wallet 460. Arrival, Start and completion add no PAYMENT. A legacy unpriced accepted order cancels as NO_DEBIT with no REFUND. The API never infers old financial results from CANCELLED status alone.

Order payloads expose `resolutionActions: []` and `cancellationReviewRequired: false`. `GET /admin/orders/cancellation-review` returns an empty paginated list. Retired `POST /admin/orders/:id/reoffer` and `/final-cancel` return 409. Old audit rows remain stored. Unrelated public/private offers, private expiry/fallback, chat and notification delivery remain intact.

Cancellation emits existing `order:cancelled` payloads to admins, the order room and the assigned driver, with the same `offerAttemptId` and `notificationEventId`. A NEW cancellation also invalidates the public popup through existing `order:taken`; private cancellation retains `order:private-offer-ended`. Balance changes emit `balance:updated` with reason PAYMENT on acceptance or REFUND on actual refund only. Driver availability and region counts reconcile after commit. Current-order, history, list and profile reads restore the terminal order and freed driver after reconnect. Balance payloads retain `amount`, `held` and `available`; new assignments use no holds, and post-migration held is zero.

## Historical transition and exact schema

Migration: `backend/prisma/migrations/20261019090000_dispatcher_cancellation_outcomes/migration.sql`.

Read-only diagnostic: `backend/prisma/preflight/dispatcher-cancellation-121.sql`. Run on a quiesced disposable/restored copy before migration. It uses `BEGIN READ ONLY` and ROLLBACK. The migration takes ACCESS EXCLUSIVE locks on drivers, orders, balances, order_assignments and transactions up front, in that order with a 15-second lock timeout, so later DDL never upgrades a lock behind an old server transaction. It repeats its fail-closed preflight under those locks before any DDL or data write, within explicit BEGIN/COMMIT. It then locks driver, order and wallet rows and converts each provable live HELD assignment's immutable quote to one linked PAYMENT and CAPTURED state. A failed preflight or conversion rolls back all schema, wallet, ledger, assignment and review changes. Prisma may mask an original transaction error with `current transaction is aborted`; the separate diagnostic exposes the actionable ambiguity. Do not bypass failed history checks.

HELD conversion requires the current assigned driver/attempt and unfinished status to agree, no ended/captured/released markers, a positive quote, a TMT wallet, no conflicting nonfailed PAYMENT/REFUND coverage, and sufficient wallet funds for all of that wallet's holds. Previously captured debits are retained. Start never debits or repairs history. Runtime cancellation requires exact completed original debit proof, rejecting partial refunds, pending entries, conflicting wallets/currency/assignments and quote mismatches.

Schema additions are nullable `orders.cancellation_outcome` TEXT, `orders.cancelled_by` TEXT, `orders.cancellation_refund_amount` DECIMAL(10,2), and `transactions.assignment_id` TEXT. Named constraints/indexes:

- `transactions_assignment_id_fkey`, assignment reference with DELETE SET NULL and UPDATE CASCADE.
- Unique `transactions_assignment_id_type_key` on assignment_id/type, enforcing one PAYMENT and one REFUND for a linked assignment.
- `orders_cancellation_outcome_check`, allowing null or WITH_REFUND, WITHOUT_REFUND, BEFORE_ACCEPTANCE, NO_DEBIT. UNKNOWN is an API fallback, not an invented database outcome.
- `order_assignments_no_new_holds_check`, rejecting HELD so an old running server cannot silently create new legacy holds.

No enum is added or changed. Historical cancellation outcomes/refund amounts remain null, and retired review flags are cleared without financial replay. Every order read, including driver and dispatcher driver history, labels a cancelled row without a recorded outcome as `UNKNOWN`. A cancelled assignment records `CANCELLED_WITH_REFUND`, `CANCELLED_WITHOUT_REFUND` or `CANCELLED_NO_DEBIT` as its end action. Pinned SHA256 values, which Prisma also records as the migration checksum: `migration.sql` `4972e792bb96f74b539441acc65886f95702afb6b7d21c844c738b38611ae674`; preflight `75e18ab1c6523594debab83b1005f47ee307bd5c52f57329a59e7620d74f904c`. The reset planner must verify these exact bytes. Catalog verification must use the exact committed migration, including pre-existing `driver_activity_audits`; pre-migration and final 1.21 catalogs are distinct stages.

## Fresh seed and reset handoff

The owner authorizes a guarded final production reset by the parent, with exactly one admin and nine canonical saved regions. This backend task performs no production read, reset or deployment. Existing operational rows may be removed through that separately reviewed path. A failed historical preflight on a restored copy does not justify weakening migration checks; the reset planner's explicitly selected, pinned pre-migration reset is the planned exception before applying this migration.

Fresh migration and retrying `backend/prisma/seed.js` produce one admin and nine canonical boundaries with no operational rows. Seed upserts the configured admin and preserves existing region boundaries; it does not delete extra admins or reset operational data. Therefore seed alone cannot establish the reset postcondition on a populated database. The reset tool must assert its exact selected catalog, preserve the existing admin/password and saved region/meta values as planned, remove operational rows through its guard, migrate, then verify the final catalog and row counts. No destructive migration or startup reset is introduced here.
