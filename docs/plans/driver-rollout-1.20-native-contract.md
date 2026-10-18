# Android bridge contract for 1.20

Native implementation owns this note and `src/features/driver/nativeUi.ts`.

## Web shell integration

Import `installNativeUi` and call once at app shell mount, dispose on unmount:

```ts
const dispose = await installNativeUi(async () => {
  // Close the topmost registered overlay through its ordinary X action first.
  // Otherwise navigate one level back, or non-Orders driver tab to Orders.
  // Return handled for either action; return root only at Orders root.
  return "root"; // "handled" | "root"
});
```

The native callback consumes an open keyboard before requesting JS. JS owns a central overlay stack, including nested menus, dialogs and the incoming offer. Do not detect private element IDs or push history entries for offers. `root` runs native two-press/2-second feedback/minimize. `handled` resets that window. Native request IDs reject late responses; missing JS has a bounded fallback. Navigation or overlay changes should call exported `resetNativeBack()` to clear a previous first root press.

The module automatically supplies theme changes to native system bars. Native emits persistent bars/cutout insets in CSS pixels as `--native-safe-top`, `--native-safe-right`, `--native-safe-bottom`, `--native-safe-left`. Web CSS should use `var(--native-safe-top, env(safe-area-inset-top, 0px))` and equivalents for header/tab/dialog controls. The root is NOT padded natively. Keep IME/visualViewport handling separate. Native module does not apply CSS padding itself.

## Exact-attempt alert lifecycle

`notifyOrder(order, { eventId, expiresAt, remainingMs? })` accepts the canonical event ID and deadline. Browser music is finite and capped at 20 seconds/server remaining time. Android uses only native system notification audio, never the WebView audio player. `closeOrderAlerts(eventIds?: string[])` stops matching attempts only when IDs are provided; absent IDs intentionally clears all order alerts for logout/shift loss. Use exact IDs for X, Back, accept, expiry, invalidation and replacement. Late invalidation for A must never clear fresh attempt B.

`reconcileOrderAlerts(eventIds: string[])` clears only vanished order IDs after a successful authoritative inbox. Do not call with [] on network failure. Native shift polling also performs this reconciliation. `nativeNotifications.clear` already accepts exact `eventIds`.

Native notification policy stores seen IDs across transports/reload for the canonical deadline and never parses an order UUID from the event ID. Reoffers need distinct backend event IDs and an explicit `expiresAt` plus `serverTime`. Notify this agent when the backend contract note is available.

## Notification preference removal

Native and JS no longer expose an enabled/muted preference or toggle. Web Profile must remove imports of `toggleNotifications`, `notificationSettings.enabled`, `alertState.enabled` and notification controls. Permission onboarding remains once per install after verified login. Native OS notification settings are the recovery route.

Native assets: `/notification.mp3` and Android `res/raw/offer_music_20s.mp3` contain identical finite trimmed/faded audio. Chat uses its own short sound and cannot reuse the offer player.
