# Dispatcher alerts and Activity (#133)

## API contract

`GET /api/admin/messages/unread` remains admin-only and read-only. It now returns:

```json
{
  "driverIds": ["driver-id"],
  "items": [{
    "driverId": "driver-id",
    "driverName": "Driver name",
    "message": {
      "id": "message-id",
      "senderId": "driver-user-id",
      "receiverId": "admin-user-id",
      "body": "Latest unread message",
      "sentAt": "2026-10-18T12:00:00.000Z",
      "isBroadcast": false
    }
  }],
  "total": 1
}
```

There is one latest unread inbound message per approved driver. Rows are newest-first by `(sentAt,id)`. All unread driver rows are returned; presentation caps visible rows at three. A single PostgreSQL snapshot reads both latest messages and shared read cursors. Existing `driverIds` callers stay compatible. Opening/reloading this endpoint does not mark messages read. Admin broadcasts and outbound admin messages are excluded.

`GET /api/admin/activity?limit=100` keeps `{items}` and existing `id,type,at,actor,summary` fields. Order resolution entries also provide `orderId,orderNumber,driverId`; driver status entries provide `driverId`. Types include `driver_approved`, `driver_blocked`, `balance_adjusted`, `order_cancelled`, `order_reoffered`, `order_final_cancelled`, and existing started-trip force resolution as `order_force_completed`.

Order cancellation/reoffer/final-cancel records come from durable `OrderResolutionAudit` rows, including the actual driver/admin actor. Reoffering preserves the original cancellation entry, order number and timestamp. Competing/repeated resolution calls returning 409 add no audit. Balance events reuse the existing transaction ledger, including its operation-id replay protection. Chat contents do not enter Activity.

Cancellation notification sound identity remains the existing canonical `notificationEventId` on both socket payloads and recovered orders (equivalent to `order:<order-id>:<offer-attempt-id>` or a private attempt). Reoffering creates a fresh attempt. Recovery should display persisted cancellations silently; only genuinely new live events should play sounds.

## Migration and deployment

`20261018200000_driver_activity_audits` adds one table and indexes. No existing table is removed or rewritten. The table stores actor/driver name snapshots and append-only approval/block transitions in the same transaction as creation/approval/block/unblock/account deletion. Repeating an already-applied approval/block does not create a transition entry.

The migration backfills only the currently retained `approvedAt` and `blockedAt` facts, with their actual timestamps and actor names when attributable. Missing actors remain null. Earlier overwritten transitions cannot be reconstructed honestly. Existing order resolution audits and balance transactions are reused; no invented records or reset is required.

Run Prisma migrations before starting the new API. Old code tolerates the additive table. Deploy API before web consumers of the new unread items. No APK/native changes are involved.

## Verification

The public HTTP auth/order-lifecycle seams use the repository's disposable PostgreSQL runner. The migration SQL is also exercised against a separate transactional schema containing known and unknown legacy actors, following the existing migration-test seam.

Red/green evidence:

- Cancellation/reoffer history: baseline failed (no order-keyed durable cancellation), then passed with original cancellation identity/time retained across reoffer and final cancellation.
- Repeated approval/block history: baseline returned one approval instead of three; append-only status history then passed. Repeated already-approved action adds no entry. Retried balance operation remains one ledger event.
- Unread recovery: baseline lacked `total` and previews; now latest-per-driver previews, shared read cursors, outgoing/broadcast exclusion, and driver-role denial pass.

Final verification:

- `pnpm --filter openride-backend typecheck`: passed (backend build plus test types).
- `pnpm --filter openride-backend test:unit`: 7/7 passed.
- `pnpm --filter openride-backend test:integration`: 181/181 passed, zero skipped, 121.13 seconds, runner exit 0; owned PostgreSQL container removed.
- `git diff --check -- backend`: passed.

This includes four new integration cases: durable order resolutions, repeated driver transitions and balance replay, unread recovery/read cursors/auth, and populated legacy migration with missing actor. Only formatting changed in `getActivity` after the full runner compiled; behavior stayed identical. All fixtures are synthetic; no shared or production database writes were made.
