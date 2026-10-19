# Release 1.21 integration checkpoint

Status recorded on 2026-10-19 before final release verification. This checkpoint records completed integration and the remaining release gates. It does not establish a completed rollout.

## Integrated candidate

The release source is `feat/release-121-integrated` in worktree `t3-81d1129b`. The handoff source commit is `371d2390b748a4b2169e33b0bd05e20ca30d3daf`; subsequent release edits must be included in final CI and artifact provenance. Current `origin/main` at handoff, `a13f8685b82ba0b09cacf982208e37db7cbf2ed1`, is an ancestor of the candidate.

All component work is integrated. Do not cherry-pick the component branches again.

| Component                                                   | Integrated source                                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Dispatcher-only cancellation and acceptance-time fare debit | `414f8ab`; governed by [the cancellation contract](dispatcher-cancellation-1.21-contract.md) |
| GPS reliability and passive status icons                    | `2e4391a`, including `98a00ff` and `aafe02d`                                                 |
| Signup without approval, issue #150                         | `aabcae8`                                                                                    |
| Guarded fresh production reset                              | `555bceb`; [reset procedure](../production-reset-1.21.md)                                    |
| Microdistrict address labels and offline startup coverage   | Included through merged PRs #145 and #147                                                    |
| Final integration fixes and passive-GPS browser fixtures    | `e28195e`, `a296ce0`, `371d239`                                                              |

The full quoted fare is deducted once at acceptance. Start and Complete never deduct again. Drivers have no cancellation action. The dispatcher chooses with or without refund for assigned unfinished trips. Cancellation-review banners, review/reoffer controls and the cancellation chime are removed. Chat and incoming-order alerts remain.

Self-registration creates an active account and signs the driver in immediately. Dispatcher-created accounts are active without replacing the dispatcher session. New accounts start offline, with no region and zero balance. GPS and connection indicators are passive; Online owns location recovery.

## Completed verification and limits

These results come from the integrated handoff and its recorded logs. They are not CI results for the final release candidate.

| Check                                 | Recorded result                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Typecheck and formatting              | Passed before the final test-only fixture update                                             |
| Backend unit tests                    | 7/7 passed                                                                                   |
| Disposable-database integration tests | 213/213 passed, `/tmp/int121b.log`                                                           |
| Modern and legacy web build           | Passed, `/tmp/build121.log`                                                                  |
| Dispatcher cancellation browser spec  | 12/12 passed, `/tmp/cancel-spec2.log`                                                        |
| Driver feed browser spec              | 20/20 passed, `/tmp/feed-spec.log`                                                           |
| Reset tool local tests                | 6 passed; 11 skipped because the database drill opt-in was absent                            |
| Reset drill CI                        | PR #152 production-backup-drill job passed, including disposable reset tests                 |
| Full integrated browser run           | Interrupted after 36 passing tests, exit 143, `/tmp/e2e121-full.log`. No completed full pass |

Earlier native component checks passed, but final integrated native build, unit and lint checks are pending. The final integrated app has no completed emulator smoke. Browser and native tests do not establish physical GPS/GMS reception, manufacturer battery behavior or audible notification cancellation on a phone.

## Remaining release gates

1. Review the cohesive integrated candidate against main for spec and coding standards. Run the existing five CI jobs on the final candidate, including full browser, backend, native and disposable reset checks. Fix actual failures and merge the reviewed green candidate.
2. Run one brief emulator smoke against an isolated synthetic backend. Verify immediate signup and reload, automatic GPS and Online, offer details and Back/X, one acceptance debit with no driver cancel, dispatcher cancellation with each refund choice across two orders, and a chat alert. Record hardware and audio limits honestly.
3. Build and verify the signed production APK, version `1.21`, code `22`, using the production endpoints and signing identity. Record its source commit, checksum, package and signing certificate. Prepare the signed offline VPS bundles and publish verified artifacts with the English and Russian notes.
4. Follow the reviewed reset and rollout procedure. Keep exactly the existing admin identity/password and all nine saved regions with their exact current geometries. Remove driver, order, balance, chat and other operational data through the guarded tool; retain the system metadata required by that tool. Record production verification in the operations handoff.

Signing, publication, production reset and rollout remain pending at this checkpoint. No artifact checksum or deployment success is claimed here.
