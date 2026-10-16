# Tayyn Hyzmat operations guide

This guide describes the driver app, dispatcher dashboard, and the rules they share. It is a working guide, not a product pitch.

## Roles and access

A dispatcher signs in with the fixed `+993` phone format and password. A driver uses the same format. The dispatcher creates or edits driver credentials; drivers do not receive or display an existing password. A phone or password reset revokes the old access and takes that driver offline. The driver keeps their approved device, balance, and active trip, then signs in again.

The pilot has one dispatcher and synthetic driver accounts. It uses TMT only and no real payments. The development seed is not a production credential store. Keep production secrets outside the repository and Railway logs.

## What the driver sees

The home screen shows all saved dispatch regions as a compact grid. Each region card shows the number of online cars and active orders. The driver cannot choose a region manually. The server assigns the current region from the driver's fresh GPS point and the saved polygon. A point outside every polygon shows **Outside region** and the real coordinates. A region centre is only a fallback coordinate, never proof of the driver's exact pickup.

The driver can open orders, map, chat, and profile from the bottom navigation. Orders and trip controls open in dialogs, so the region grid stays compact. Message history scrolls inside the chat; Enter sends a message and Shift+Enter adds a line.

## Readiness and going online

GPS, network, dispatcher connection, and availability are different facts:

- **GPS ready** means Android or the browser has permission and a fresh local fix. It can stay green when the phone has no internet.
- **Connected** means the app can reach the API and Socket.IO. It is required for live work.
- **Online** means the driver explicitly started a shift and the server accepted a fresh location report.
- **Outside region** describes the GPS point. It does not mean GPS is broken.

The Online action must confirm a fresh location with the server before it turns green. Address lookup never blocks this action. A stale or missing GPS report stops new offers and eventually expires the online lease. An accepted trip remains assigned while the driver reconnects.

On Android, location and notification permissions are requested while the app is visible. During a shift the native service renews a 60-second server lease and polls the canonical order/chat inbox. Force-closing, swiping the task away, logout, or lease expiry ends availability. Doze and manufacturer battery rules can delay a notification, so physical-phone checks remain a release gate.

The merged readiness contract separates local GPS, dispatcher connection and shift availability. Canonical busy-driver availability (#94, `b21b4d0`) now overrides stale flags in status responses, monitoring lists and region counts. Offline stops recurring location uploads and keeps a timestamped last position. Foreground return checks Android permission and system GPS again. Hardware and background reliability still require the target-phone checks.

## Regions and order counts

The dispatcher edits saved polygons in the region editor. A save requires a fresh read and an explicit confirmation. The versioned defaults in `backend/prisma/data/default-regions.json` seed new isolated environments. Tests never write to the supporting developer's shared region database.

The dispatcher roster can search by driver name, phone, or plate and filter by region or status. On mobile it opens as a bottom sheet. GPS events patch known rows instead of reloading the whole fleet. The map and roster show online, on-trip, GPS-check, and offline states. Overlapping markers remain reachable from the roster.

## Creating an order

The dispatcher chooses a region, enters a valid customer phone, and enters a positive TMT price. Those are required. Pickup and destination points, map selection, address text, and notes are optional. The customer phone stays hidden from drivers until they accept. A driver calls the customer after acceptance to confirm practical pickup details.

On wide screens, the form and a larger map appear side by side. On smaller screens, the map stays below the form. Choose pickup or destination, then place the corresponding point on the map. Clear a point if it is incorrect; a map point never replaces the required region. You can send an order without map points.

The dispatcher can announce an order publicly or choose a private driver. A private driver can be selected from the map or roster. Selection does not move the order to the driver's region.

## Private offers and public claims

A private offer is a reservation for one eligible online, idle driver with fresh GPS and enough balance for the quoted price. The server persists a fixed 20-second deadline. The driver must explicitly accept; opening the offer, waiting, or declining does not charge money.

Acceptance is a race. The server accepts only the first valid claim and broadcasts removal to other drivers. It charges the quoted TMT amount once, then reveals the customer phone. An early decline returns a private offer to its original region until the original deadline.

A public order starts in its original region for 20 seconds, then opens to all eligible drivers at once. For a private offer, the dispatcher chooses whether its fixed 20-second expiry opens the order globally or stops it unassigned. There is no second acceptance timer. PR #79 (`715b648`) is merged.

## Balance rules

A driver needs a positive synthetic balance to go online or receive public work. Orders above the balance remain visible, but acceptance is disabled with a clear explanation. Acceptance requires the full quoted amount and never creates a negative balance. An exact balance is sufficient. Reservations do not debit or hold funds. Completion does not charge again. Cancellation refunds the existing charge according to the order state.

Every dispatcher balance adjustment has a unique operation identifier. If the response is uncertain, retry the same unchanged action; the app reuses its identifier instead of adding money twice. An old dashboard tab that asks you to refresh must reload before adjusting balances. Check the current balance and history before starting a different adjustment.

Removing a driver deactivates access and preserves their balance, ledger and order history. A driver with an active trip cannot be removed. Resolve that trip first.

## Trip lifecycle

The normal sequence is:

1. The dispatcher creates a public or private order.
2. A driver explicitly accepts it.
3. The driver arrives and marks the customer as waiting.
4. The driver starts the trip after the customer boards.
5. The driver completes the trip.

The driver can cancel only while waiting for the customer, in `WAITING`. The driver cannot cancel in `ACCEPTED` or after the trip starts. The dispatcher can cancel `NEW`, `ACCEPTED` and `WAITING` orders, but cannot cancel a `STARTED` trip. The API enforces these rules, including requests from old screens.

Cancellation means the trip did not take place. It closes the order and refunds its recorded acceptance charge once. Completion means the trip was provided. It keeps the original charge and does not debit again. Use the action that matches what happened, rather than cancelling to clear a stuck screen.

After 15 minutes, a started trip shows a Needs completion warning. This warning does not complete the trip. Contact the driver first. If the completed drive is stuck in the app, the dispatcher can complete it manually with a required reason. The action keeps the same driver and charge, and records the dispatcher and reason. Exceptional refunds need a separate reviewed recovery process.

If a driver loses network after acceptance, the trip remains assigned. New offers stop until the lease and GPS rules allow work again. A dispatcher sees the last location with its age; a stale point is not treated as live eligibility.

## Choosing a trip action

The following dispatcher contract is enforced in the release candidate. The driver has a different cancellation rule: cancellation is allowed only in `WAITING`.

| Order state            | Dispatcher action                         | What happens to the balance                                      |
| ---------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| NEW                    | Cancel an unassigned order                | No acceptance charge exists to refund                            |
| ACCEPTED or WAITING    | Cancel before the trip starts             | Refund the original recorded charge once and free the driver     |
| STARTED                | Complete manually after checking the trip | Keep the existing charge, record the reason and who completed it |
| COMPLETED or CANCELLED | Review history                            | No repeated completion, cancellation or extra debit              |

Manual completion confirms that the drive was provided. It is available for a started trip; the 15-minute warning only draws attention to an unfinished trip. Call the driver first. Enter a useful reason such as "Driver confirmed customer arrived; app connection failed." The reason and dispatcher identity remain in the record. Completion counts as completed work and does not refund the order price. Exceptional refunds need a separate reviewed recovery process.

## Notifications and chat

The browser uses Socket.IO while the app is open and reconnects or reconciles state when it returns to the foreground. A closed browser cannot guarantee delivery. The Android test service polls a stable inbox every 10 seconds and uses separate order and chat notification channels. It hides customer phones and chat bodies on the lock screen. Notification taps open the relevant screen and the server remains the source of truth.

Chat has independent scrolling, draft preservation on a failed send, and automatic bottom-following only when the reader is already near the bottom. It recovers missed messages after reconnect, loads older history without gaps, and preserves unread messages when timestamps match. A retry reuses the same message identity to avoid sending a duplicate. Read acknowledgement runs only while the chat is visible. Routine refresh controls are replaced by live recovery and deliberate retry after failure (PR #87, `2935991`).

## Driver addresses and the Yandex quota

GPS and polygon matching decide eligibility. Address lookup only adds a street or building label. The server policy is merged in PR [#68](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/pull/68) (`cf8bf84`); provider activation and live configuration checks remain separate. It looks up a visible driver location no more than once per five minutes after meaningful movement, shares a daily cap across devices and restarts, keeps 20% in reserve, backs off on provider errors, and falls back to coordinates. A stale address is hidden when the driver moves. A provider failure or exhausted quota never blocks GPS or going online.

## Analytics

The compact Today view uses Asia/Ashgabat time for orders created today. It keeps all currently waiting orders in a separate live section, including orders created earlier. The first measures are waiting count, oldest waiting age, median and p90 acceptance time, completed count/rate, and cancelled count/rate. PR #67 is merged after all CI checks passed. Private-offer conversion and shift utilisation need more history and are later work.

## Recovery and safety

Every action is server-authoritative. Reload restores the active trip and balance. Reconnect replays missed state through HTTP and Socket.IO. A response from an old screen must not overwrite newer location or order data. A driver who is offline may retain a timestamped last location, but that point cannot receive an offer or count as online.

## Current release map

Merged to `main` and deployed: offer modal polish (#76), map GPS eligibility (#74), monitoring roster (#78), funded acceptance and no-negative-balance (#77), and stuck-trip resolution (#80, `e821397`). GitHub hygiene closed superseded work and left active issues and open PRs in place.

The standalone driver login shell is merged through PR #81. Monitoring region filters now include all saved active regions through PR #84. Superseded PRs #50, #55, and #82 are closed.

Chat recovery (#87), shared address budgeting (#68), and consistent locking for concurrent trip resolution (#90) are also merged.

Readiness-state separation (#85, `2095f56`) and audience expansion (#79, `715b648`) are merged.

Today analytics (#67) is merged. Pending: provider activation checks; physical Infinix Android 14 background/Doze verification; and release signing/update policy. The compact driver feed (#95) and canonical busy-driver availability (#94) are merged. The separate client-facing progress brief is linked from the guide index.
