# Dispatcher alerts and activity UI verification

The dispatcher shell now keeps cancellation review and chat alerts in a shared, bounded alert area beneath the workspace header. Each alert type owns its own scroll region, so a long burst cannot cover navigation or the page heading. The largest three unread drivers and largest three unresolved cancellations remain visible, with links to the complete list.

Chat previews are keyed by driver and recover from `GET /admin/messages/unread` without replaying a sound. Opening a conversation syncs the server read cursor; closing a preview only dismisses that tab's preview and never marks it read. Activity entries include the actor, timestamp and order link when the backend supplies an order number.

Cancellation review events use the canonical `notificationEventId` and play a short cancellation chime. Chat uses the existing softer chime. Web Locks, same-origin storage, a short shared cooldown and exact event identities prevent duplicate or overlapping playback across tabs. Autoplay, storage and lock failures leave the visual alerts usable.

## Evidence

- `tests/browser/admin-message-alerts.spec.ts`: existing chat sound/read/reconnect regressions plus grouped driver previews, canonical unread recovery, cancellation chime and cancellation resolution races.
- Focused UI run: 30/30 message-alert cases passed after the grouped-alert changes.
- Full disposable browser run: run after the final UI commit; record the exact total here before release.
- Screenshots captured in `.local/dispatcher-alerts-validation/desktop-four-alerts.png` and `mobile-dark-large-text.png` using synthetic drivers/orders only.
