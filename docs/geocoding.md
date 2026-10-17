# Driver addresses and provider limits

GPS coordinates and saved active region polygons determine a driver's operating region. An address is optional display information. Geocoder configuration, quota exhaustion and provider failures never gate GPS reporting, Online, order browsing or an accepted trip. Outside every polygon, show `Вне районов` and the actual coordinates. Never substitute a nearest centre or a provider administrative area.

## Lookup policy

The driver home and dispatcher driver-details Info tab request `GET /geo/drivers/:driverId/address` only while visible. The native background GPS service has no address lookup path. Drivers can request their own address; an authenticated dispatcher can request any active approved driver's address. The server reads fresh saved GPS and ignores caller-supplied coordinates. Stale GPS produces no address or position in this endpoint; existing screens may still label their last recorded coordinates separately.

The first provider lookup is immediate. Further attempts require both five minutes since the previous attempt and at least 150 metres from its source position. Driver and dispatcher requests, devices, reloads and API instances share that persisted gate. PostgreSQL serializes reservations before any outbound request. Every attempted provider call, including errors and timeouts, consumes the budget. Cancelling a browser request does not refund an attempted call.

The automatic fleet ceiling is `floor(confirmed daily limit × 0.8)`. The remaining 20% is unused reserve, with no automatic endpoint allowed to spend it. This application counter cannot account for other applications, API keys or SDK consumers sharing the vendor account. Configure its confirmed allocation accordingly and monitor the provider's own account usage.

Provider calls use the private Yandex HTTP Geocoder adapter with longitude first, a four-second timeout and street/building output. There is no public Nominatim fallback. Failures open a shared persisted backoff of 30 seconds, doubling to five minutes after repeated failures. HTTP 403 opens a one-hour breaker. Already in-flight requests can finish; later reservations respect the breaker. Success cannot erase a newer concurrent failure.

## Server configuration

These variables belong only in the API service. Never add the private credential to Vite variables, web Docker build arguments or the APK. The public Maps JavaScript credential remains separate.

| Variable | Meaning |
| --- | --- |
| `YANDEX_GEOCODER_API_KEY` | Credential explicitly enabled/licensed for HTTP Geocoder. Missing means coordinate fallback. Do not infer it from the public Maps key. |
| `YANDEX_GEOCODER_REFERER` | Optional HTTPS origin allowed by the key's domain restrictions, for example `https://dispatch.example`. The API sends its normalized origin plus `/` as the provider request's `Referer`. Credentials, paths, query strings, fragments, control characters and backslashes are rejected. Missing sends no Referer; invalid configuration disables lookups. |
| `YANDEX_GEOCODER_DAILY_LIMIT` | Confirmed positive integer allocation, at least 2. No assumed 1,000-request default. |
| `YANDEX_GEOCODER_QUOTA_TIMEZONE` | Explicit IANA timezone for the operator's confirmed quota day. Missing/invalid means fallback. |
| `YANDEX_GEOCODER_QUOTA_RESET_HOUR` | Local reset hour 0–23, default 0. This is an application policy setting, not a claim that Yandex resets at midnight in that timezone. Confirm the account's billing/reset period before enabling. |
| `YANDEX_GEOCODER_CACHE_SECONDS` | Optional address cache, 0 by default. Positive integer up to 300, enabled only when the deployment contract permits retention. |

All API instances must use the same quota policy. Keep timezone and reset hour stable during a quota day. The budget uses a monotonic local-day identifier and never replenishes on a backward day transition; restart, redeploy, key rotation and application rollback preserve counters. Missing or invalid configuration disables provider calls. Deployment must apply the additive migration before running the new API; it creates metadata tables and does not alter drivers, balances or region boundaries. Roll back application code first and retain these tables/counters when reverting.

The 2026-10-16 integration retest returned HTTP 403 without a Referer and HTTP 200 with an Ashgabat address when the same key received the allowed Railway web origin. This identifies a domain-restriction mismatch for that tested key. It does not mean every 403 has that cause. Set `YANDEX_GEOCODER_REFERER` to an origin already allowed by the selected key. The server uses this configuration only, never a caller-supplied Referer or the APK's `https://localhost` origin. No web or APK rebuild is required for this API configuration change.

A previous 403 may have opened the persistent one-hour breaker. A redeploy preserves it. Wait until it expires, or have the operator review and clear that breaker after confirming the corrected provider request succeeds. Keep the request counter and driver attempt timestamps intact.

## Retention and stale responses

With cache seconds 0, no provider address is written to PostgreSQL. Only our source GPS coordinates and attempt time are retained per driver, plus the fleet counter/breaker. With licensed caching enabled, matching driver/dispatcher requests within 150 metres can reuse a cached address until expiry, with original lookup time preserved so cache hits cannot restart the five-minute display lifetime. Cache payloads are erased at startup and by a 60-second sweep after expiry, so the permitted retention window must include that cleanup delay. No expired payload is served. Ordinary Delete account archives the identity and keeps historical records. The deleted account is ineligible for new address lookups; cached provider payloads still expire through the same sweep. Only explicit isolated-environment maintenance resets remove the address-state rows.

The frontend retains only the currently displayed address in memory. It clears it on account changes, loss of GPS readiness, navigation/unmount, movement of 150 metres or five minutes of age. Late replies cannot replace a newer position. A missing/currently invalid address displays live coordinates. Optional address HTTP polling runs at most once per 30 seconds on a visible location screen; it does not bypass the server's provider gate. Backgrounding invalidates pending display replies and stops new address demand.

The historical `GET /geo/reverse?lat=…&lng=…` contract remains available to dispatchers for order-map compatibility but returns `address: null`, coordinates and `reason: unavailable`, without spending provider quota. Drivers cannot use it to bypass fleet limits. Pickup/drop-off points and manually entered optional addresses still work. Paid order-map reverse lookups require separately scoped budget rules.

## Verification limits

Disposable-database HTTP tests cover authorization, coordinate fallback, private credential handling, restricted-key Referer handling and invalid configuration, five-minute and movement gates, races, the reserve, restart/instance persistence, day rollover, caching, provider errors and timeout. Browser tests use the real API/database and simulate only the external HTTP Geocoder. A delayed real API response verifies stale-display rejection. Automated tests do not verify a live vendor key, account entitlement, account reset timezone or physical Android background behavior. The live Referer retest above verifies only the tested key, origin and point; deployment still needs its own authenticated address check.
