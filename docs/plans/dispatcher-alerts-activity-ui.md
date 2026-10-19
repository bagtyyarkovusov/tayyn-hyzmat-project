# Dispatcher alerts and activity UI verification

The dispatcher shell now keeps cancellation review and chat alerts in a shared, bounded alert area beneath the workspace header. Each alert type owns its own scroll region, so a long burst cannot cover navigation or the page heading. The latest three unread drivers and latest three unresolved cancellations are listed, with links to the complete list.

Chat previews are keyed by driver and recover from `GET /admin/messages/unread` without replaying a sound. Opening a conversation syncs the server read cursor; closing a preview only dismisses that tab's preview and never marks it read. Activity entries include the actor, timestamp and order link when the backend supplies an order number.

Cancellation review events use the canonical `notificationEventId` and play a short cancellation chime. Chat uses the existing softer chime. Web Locks, same-origin storage, a short shared cooldown and exact event identities prevent duplicate or overlapping playback across tabs. Autoplay, storage and lock failures leave the visual alerts usable.

## Evidence

- `tests/browser/admin-message-alerts.spec.ts`: existing chat sound/read/reconnect regressions plus grouped driver previews, canonical unread recovery, cancellation chime and cancellation resolution races.
- Red: second driver replaced the first driver preview; the first row was absent. After grouping by driver, both remain visible and reload restores both without sounds.
- Red: a real driver cancellation produced no cancellation chime. After implementation the distinct cancellation chime plays exactly once across two same-origin tabs, after the chat chime has stopped.
- Red: Activity had no order links. It now preserves both cancel/reoffer decisions with actor, semantic time and the correct order link after reload.
- Focused UI runs: initial message/audio suite 26/26; final Activity, cancellation, four-alert layout and resolution-race subset 4/4. These overlap in the cancellation case; no claim of 30 distinct tests.
- `pnpm typecheck`, `pnpm format:check` passed. Impeccable detector reported only four inherited `App.vue` literal font-size advisories, outside this change.
- Full disposable browser run collected 193 cases, then the host Docker daemon stopped after 104+ passing cases. PostgreSQL logged `FATAL: terminating connection due to administrator command`, followed by a missing Docker socket. The owned runner was stopped; this is incomplete broad verification, not a source pass or source failure. Log: `.local/dispatcher-alerts-validation/browser-full.log`. Repeat the full suite once Docker is available.
- Screenshots captured in `.local/dispatcher-alerts-validation/desktop-four-alerts.png` and `mobile-dark-large-text.png` using synthetic drivers/orders only.
