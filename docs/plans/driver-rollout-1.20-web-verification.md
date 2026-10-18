# Release 1.20 web implementation and verification

This checkout integrates the approved scope with the backend and native bridge implementations. It makes no production changes.

## Behavior

- Driver Profile owns logout and has no notification setting. Incoming offers share route icons with regional queues, a prominent quote, note, ETA, visible countdown/progress and contrasting 48px close target.
- A central opening-order stack closes shared dialogs and menus through their ordinary handler before Back returns other driver tabs to Orders. Native owns keyboard-first Back and root minimization. Shell/dialog CSS consumes native safe insets.
- ACCEPTED orders alone expose driver cancellation, with a simple confirmation. Dispatcher review banners link order numbers and drivers. Unresolved rows alone expose reoffer and final cancellation. Balances distinguish total, held and available.
- Dispatcher broadcast history is a separate conversation. Individual histories label merged broadcasts; driver replies remain private.
- The offer controller consumes canonical exact-attempt IDs and successful authoritative inbox snapshots, including `serverTime`. HTTP failures never reconcile an empty inbox. Timers, dismissals and delayed invalidations target their original event ID.
- Completion feedback is consumed by trip/attempt/action identity outside the route component. The browser regression reproduced the duplicate before this guard and checks both remount suppression and a later trip using the same message.
- Maps follow fresh local GPS until a pan and resume on Locate. Off-shift observation does not upload GPS. Locate stays above vendor attribution and zoom controls are removed.

## Validation at implementation handoff

`pnpm typecheck` and `pnpm format:check` pass. New integrated browser cases pass against the disposable PostgreSQL/API/socket runner, covering completed-trip remount, incoming typography/deadline, exact stale attempt A versus same-order reoffer B, native Back callbacks, broadcast privacy/history, held balances and map follow behavior. The full 184-test browser run is underway; its final result will be recorded in a follow-up.

The repeated-toast test uses a synchronous post-navigation count after mounting feedback. Retrying a zero-count assertion would otherwise pass when a duplicate toast merely expired. The stale-attempt test holds a real successful `order:taken` WebSocket frame and releases it after the real reoffer is visible. Public API behavior is not fulfilled by test stubs. Native bridges and the external map SDK are simulated boundaries.

[Small light incoming offer](../evidence/driver-rollout-1.20/incoming-small-light.png), [enlarged dark incoming offer](../evidence/driver-rollout-1.20/incoming-large-dark.png), [native safe insets](../evidence/driver-rollout-1.20/native-safe-insets.png), [broadcast history](../evidence/driver-rollout-1.20/dispatcher-broadcast-history.png) and [regional queue](../evidence/driver-rollout-1.20/queue-many-orders-mobile.png) are synthetic browser evidence. Light/dark, 320px and enlarged text were visually inspected. Active-trip checks also cover five phone viewports including short landscape.

The Impeccable detector reports advisory typography-ramp gaps, including inherited compact labels and the intentional 36–48px offer price. No blocking findings. No physical Android keyboard/system-bar or live Yandex rendering proof is claimed. Those checks require the integrated APK and a usable restricted vendor key/device.

## Carried collaborator history

Preserve each commit once during parent integration:

| Original                       | Local cherry-pick |
| ------------------------------ | ----------------- |
| Native `a783e9a`               | `e36299a`         |
| Native `c992178`               | `1ed5098`         |
| Backend `b7597d1`              | `90ab908`         |
| Backend `688bc785`             | `184b5e1`         |
| Native `dbd310b`               | `442d723`         |
| Backend verification `aa005e9` | `ab0c182`         |

The backend verification note records the owner's final 177/177 isolated integrations and 7/7 unit tests. Native verification records 21 Gradle tests, debug/release assembly and lint. These are collaborator results, separate from this checkout's frontend run. Parent owns independent review, release builds and deployment.
