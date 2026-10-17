# Tayyn Hyzmat operations guide

This guide describes the driver app, dispatcher dashboard, and the rules they share. It is a working guide, not a product pitch.

## Roles and access

A dispatcher signs in with the fixed `+993` phone format and password. A driver uses the same format. The dispatcher creates or edits driver credentials; drivers do not receive or display an existing password. A phone or password reset revokes the old access and takes that driver offline. The driver keeps their balance and active trip, then signs in again.

In the current candidate, dispatcher approval applies to the driver account. An approved account can sign in on any phone without separate device approval. Several phones can remain signed in and use chat, but exactly one owns the shift. A second phone cannot start a shift or change the working phone's location or trip progress until the owner goes Offline, logs out, or its 60-second availability expires. Signing in alone does not take over the shift. Device identifiers stay internal; there is no device-management screen. An accepted trip stays assigned to the account.

The dispatcher can choose Sign out everywhere to revoke all sessions and end that driver's shift. This preserves the assigned trip, password and balance. If a phone is lost, reset the password as well: signing out does not prevent someone who knows the password from signing in again.

The pilot has one dispatcher and synthetic driver accounts. It uses TMT only and no real payments. The development seed is not a production credential store. Keep production secrets outside the repository and Railway logs.

After the first verified driver login, the APK asks for precise location, then notifications. Enable Android system location. Denied or dismissed prompts do not repeat on login or reload; use GPS or Profile to recover manually. Notification permission never blocks a shift. Permission prompts alone do not start a shift or send an off-shift location. Browsers and dispatcher screens do not ask automatically.

## What the driver sees

The home screen shows all saved dispatch regions as a compact grid. Each region card shows active orders first and online drivers second: orders:drivers. Active orders include accepted trips until completion or cancellation. The count is not the number available to claim; a claimed offer disappears from the queue even while that region count stays unchanged. The driver cannot choose a region manually. The server assigns the current region from the driver's fresh GPS point and the saved polygon. A point outside every polygon shows **Outside region** and the real coordinates. A region centre is only a fallback coordinate, never proof of the driver's exact pickup.

The driver can open orders, map, chat, and profile from the bottom navigation. The current trip shows its price, call action and next step above the grid. Open its details dialog for route information and permitted cancellation. Region order lists use dialogs. Message history scrolls inside the chat; Enter sends a message and Shift+Enter adds a line.

## Readiness and going online

GPS, network, dispatcher connection, and availability are different facts:

- **GPS ready** means Android or the browser has permission and a fresh local fix. It can stay green when the phone has no internet.
- **Connected** means the app can reach the API and Socket.IO. It is required for live work.
- **Online** means the driver explicitly started a shift and the server accepted a fresh location report.
- **Outside region** describes the GPS point. It does not mean GPS is broken.

The Online action must confirm a fresh location with the server before it turns green. Address lookup never blocks this action. A stale or missing GPS report stops new offers and eventually expires the online lease. An accepted trip remains assigned while the driver reconnects.

In the current Android candidate, the shift service renews a 60-second server lease. Swiping the app from recent tasks does not end the shift. Explicit Offline or logout ends it. During a network interruption the app tries to recover on the same device for 60 seconds. If recovery fails, restore the connection and tap Online again. Accepted trips remain assigned. Android Force stop blocks delivery until the app is reopened; availability expires without fresh reports. Doze and manufacturer battery rules still require physical-phone verification.

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

Acceptance is a race. The server accepts only the first valid claim and broadcasts removal to other drivers. It charges the quoted TMT amount once, then reveals the customer phone. An early decline dismisses the private offer without exposing it publicly before the original deadline.

A public order is available to every eligible online driver immediately. Only drivers in the selected region receive the 20-second incoming popup; other drivers open the live region list and can claim immediately. For a private offer, the dispatcher chooses whether its fixed 20-second expiry opens the order globally or stops it unassigned. Fallback updates lists without another incoming popup. Acceptance removes the offer from every driver’s queue.

## Balance rules

A driver needs a positive synthetic balance to go online or receive public work. Orders above the balance remain visible, but acceptance is disabled with a clear explanation. Acceptance requires the full quoted amount and never creates a negative balance. An exact balance is sufficient. Reservations do not debit or hold funds. Completion does not charge again. Cancellation refunds the existing charge according to the order state.

Every dispatcher balance adjustment has a unique operation identifier. If the response is uncertain, retry the same unchanged action; the app reuses its identifier instead of adding money twice. An old dashboard tab that asks you to refresh must reload before adjusting balances. Check the current balance and history before starting a different adjustment.

Deleting an account permanently removes access; there is no Reactivate action. Its old balance, ledger, messages and order history remain for records. Resolve all assigned trips first. The released phone can submit a new application, which needs dispatcher approval and starts with zero balance and no inherited history.

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

The current Android candidate delivers chat alerts independently of shift and GPS to every signed-in installation of an approved account. Foreground events use Socket.IO; Firebase Cloud Messaging is the fallback for missed or background delivery. Alerts include a message preview, subject to Android lock-screen privacy settings. Dashboard, Map and Profile show incoming previews; the visible chat stays quiet. Reading synchronizes across devices and removes the corresponding alerts. Logout, account blocking and credential changes revoke the old installation access. A closed browser cannot guarantee background delivery. Android Force stop, network loss and battery restrictions can prevent or delay delivery. These paths still need verification on the target phone.

Profile contains one notification control for both orders and chat. Muting notifications or denying Android notification permission never blocks starting a shift. To receive system alerts, enable both the Profile control and the Android permission. Dispatchers receive a banner, sender, preview and short sound in each signed-in dashboard tab outside the active conversation. Browser sound may require a prior tap or click.

Chat has independent scrolling, draft preservation on a failed send, and automatic bottom-following only when the reader is already near the bottom. It recovers missed messages after reconnect, loads older history without gaps, and preserves unread messages when timestamps match. A retry reuses the same message identity to avoid sending a duplicate. Read acknowledgement runs only while the chat is visible. Routine refresh controls are replaced by live recovery and deliberate retry after failure (PR #87, `2935991`).

## Profile order history

Open Profile and expand a history entry to review its TMT price, status, region and date. Available details include pickup and destination, the customer phone with a call action, dispatcher notes, cancellation reason and lifecycle timestamps. Missing route details are left unspecified; contact the customer when needed. The order identifier helps the dispatcher find the same record. History describes an existing order and does not create a second charge or repeat its lifecycle actions.

## Driver addresses and the Yandex quota

GPS and polygon matching decide eligibility. Address lookup only adds a street or building label. The server policy is merged in PR [#68](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/pull/68) (`cf8bf84`); a direct live request now succeeds with the configured allowed Referer. Automatic lookups remain disabled until the daily quota reset period and timezone are confirmed. It looks up a visible driver location no more than once per five minutes after meaningful movement, shares a daily cap across devices and restarts, keeps 20% in reserve, backs off on provider errors, and falls back to coordinates. A stale address is hidden when the driver moves. A provider failure or exhausted quota never blocks GPS or going online.

## Analytics

The compact Today view uses Asia/Ashgabat time for orders created today. It keeps all currently waiting orders in a separate live section, including orders created earlier. The first measures are waiting count, oldest waiting age, median and p90 acceptance time, completed count/rate, and cancelled count/rate. PR #67 is merged after all CI checks passed. Private-offer conversion and shift utilisation need more history and are later work.

## Recovery and safety

If the app cannot verify the session during a connection failure, it keeps the sign-in details and shows a retry screen. Restore internet and choose Повторить подключение, or return to the app after the network recovers. Do not create another account to bypass this screen. An expired or revoked session requires signing in again.

Every action is server-authoritative. Reload restores the active trip and balance. Reconnect replays missed state through HTTP and Socket.IO. A response from an old screen must not overwrite newer location or order data. A driver who is offline may retain a timestamped last location, but that point cannot receive an offer or count as online.

## Current release map

Merged to `main` and deployed: offer modal polish (#76), map GPS eligibility (#74), monitoring roster (#78), funded acceptance and no-negative-balance (#77), and stuck-trip resolution (#80, `e821397`). GitHub hygiene closed superseded work and left active issues and open PRs in place.

The standalone driver login shell is merged through PR #81. Monitoring region filters now include all saved active regions through PR #84. Superseded PRs #50, #55, and #82 are closed.

Chat recovery (#87), shared address budgeting (#68), and consistent locking for concurrent trip resolution (#90) are also merged.

Readiness-state separation (#85, `2095f56`) and audience expansion (#79, `715b648`) are merged.

Today analytics (#67) is merged. Pending: provider activation checks; physical Infinix Android 14 background/Doze verification; and release signing/update policy. The compact driver feed (#95) and canonical busy-driver availability (#94) are merged. The separate client-facing progress brief is linked from the guide index.

## GPS on two phones and account safety

Off shift, GPS only obtains a local fix on that phone. It does not upload coordinates or fetch an address. Each phone shows its own coordinates. Tap Online to submit the fresh fix and start the shift together; only the working phone then sends regular location reports. Another signed-in phone cannot overwrite that location. Explicit Offline stops reports even if a trip remains assigned. The dispatcher sees the last reported point and time, with an unfinished-trip warning where needed.

Use **Выйти на всех устройствах** to end all sessions and the shift without changing the password, balance or assigned trip. Use **Заблокировать** for a temporary access restriction: enter a required reason, then confirm the warning. Access ends immediately even during a trip; the trip stays assigned with no automatic cancellation, reassignment or refund. Contact the driver and resolve the trip separately. **Разблокировать** permits a new login. **Удалить аккаунт** is permanent and has no recovery action; use Block when you intend a temporary restriction.

Permanent account deletion preserves historical statistics and financial attribution. Clearing an isolated test environment is separate maintenance, never the ordinary Delete action.
