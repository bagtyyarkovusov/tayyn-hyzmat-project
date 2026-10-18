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

## Review and broader-run follow-up

The map listener now uses documented `boundschange` center values together with a moved pointer gesture. Yandex's `actionbegin` supplies an action object, so the earlier gesture-type assumption was removed. The map browser regression passes with the corrected external SDK fixture.

Broadcast pagination keeps loaded older messages and the reader's scroll position during live sends. A real 33-message API/browser regression passes. Enlarged 320px prices wrap without clipping; long dispatcher addresses no longer widen the grid. The complete private-offer/started-recovery targeted run passes 13/13, including light/dark at 320/390px and delayed decline versus a newer offer. Three affected workflow cases pass separately, and regional reconnect/reload passes separately. Browser fixtures now use the authoritative inbox endpoint, preserve the approved hold-until-start balance assertions and clean orders before drivers to respect assignment foreign keys.

The initial broad run found these failures before their fixes, including follow-on queue pollution from failed fixture cleanup. It is retained as diagnostic evidence, not described as a full passing run. Typecheck and formatting pass after the follow-up; modern plus retained legacy build passed before the follow-up. Final broader coverage remains pending at this commit.

The release-note draft originally `9abd556` is carried as `f9bdd55`.

## Controlled-overlay review fix

Shared Dialog and DropdownMenu preserve Reka's controlled contract. A supplied `open` prop remains parent-owned; an omitted prop uses local state. Escape, X and native Back cannot hide a pending dialog when its parent refuses closure. The browser regression failed on Escape before the fix, then passed with the failed request's error still visible. Private-offer decline failure through native Back also keeps the offer and error visible. Broadcast pagination failures now show a contextual error and a working retry.

The review-focused nine-case run passes, including pagination retry, controlled-dialog refusal/failure, private decline failure, ACCEPTED-only cancellation visibility and all five trip navigation variants. The initial broad run finished 169/184 with 15 failures, including cascades from obsolete cancellation/charge assertions and failed fixture cleanup. All directly affected cases have focused passing reruns. A final 187-case broad run is in progress after the shared primitive changes. Typecheck and formatting pass; final modern/legacy build is being repeated.

Owned diagnostic logs, error-context reports, screenshots and the controlled-dialog red trace are retained in ignored `.local/release1.20-validation/`. After preservation, 76 MiB of superseded owned traces were removed. Shared caches, dependencies, other checkouts and Docker resources of uncertain ownership were untouched.

## Delayed acceptance and asymmetric cutout

A further transport regression held a real successful acceptance response for attempt A, cancelled A through the driver API, reoffered the same order through the dispatcher API, then released A after B was visible. Before the fix B disappeared. Acceptance now dismisses only its response's exact notification event and preserves a newer incoming/active assignment until canonical refresh. The regression passes.

The native Back case also checks short landscape with an asymmetric 72px cutout. Dialog horizontal centering now accounts for unequal safe insets, keeping the close control within usable bounds. Both targeted cases pass. [Enlarged 320px high-price evidence](../evidence/driver-rollout-1.20/incoming-large-price-320.png) confirms wrapping rather than clipping. No physical-device claim is implied.

## Touch-target follow-up

Active-trip arrival, start and completion actions, the accepted-state cancellation action, and both cancellation confirmation actions now use the approved `min-h-12` (48px) target with wrapping preserved. The focused browser assertion checks the computed minimum height, content fit and visible controls at the accepted, waiting and started states, including both confirmation buttons at enlarged text. The targeted 390x844 case passed 1/1 after the correction. The previously recorded 187/187 broad run and 2/2 late acceptance/cutout run remain unchanged; no broad rerun was performed.


## Final local result

- The final disposable browser run passed **187/187 in 7.5 minutes**, with no failures or skips. It includes the controlled-overlay, pagination-retry, incoming-layout, Back, cancellation, funding, chat privacy and map regressions.
- The later acceptance-response/cutout focused run passed **2/2**. The acceptance case was added after broad test collection, so the current suite contains 188 cases. No further broad repeat was needed after the passing run.
- `pnpm typecheck`, `pnpm format:check` and `pnpm build` passed after the final code changes at `387e02d`. Build includes modern and retained legacy output. `git diff --check` passed.
- The draft integration PR is [#132](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/pull/132). The release checkout was verified clean and fast-forwarded from the approved specification through all carried collaborator/UI commits, preserving history once. No main merge or deployment occurred.

Passing-run temporary Playwright artifacts cleared about 600 MiB automatically on exit, in addition to the earlier 76 MiB reclaimed. The generated frontend distribution was removed after preserving its successful build log. Final logs and both red regression traces remain in `.local/release1.20-validation/`; named screenshots remain committed. All disposable containers created by the completed runs removed themselves. An older container of uncertain ownership was inventoried and left untouched. Shared caches, dependencies and other worktrees were not cleaned.

Remaining parent release gates are operations/reset review, integrated signed APK/device verification, physical keyboard/system-bar/audio behavior and live vendor-map rendering. Backend/native owner evidence remains separate from local web verification. This note does not mark those gates complete.
