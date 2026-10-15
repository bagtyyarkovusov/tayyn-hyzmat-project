# Coding standards

Adapted from `auto.tm-rewrite/docs/agents/coding-standards.md` and the Matt Pocock `codebase-design` and `tdd` skills. These rules govern new and changed behavior. Existing unrelated code is follow-up work, not an invitation to rewrite the repository.

## Modules

Hide decisions and complexity behind a small public interface. Keep domain terms consistent with the glossary. Extract a module when it removes complexity from callers, not merely to expose a private helper to tests. Add abstractions where a real dependency varies. Keep HTTP controllers focused on input, delegation and output.

Use domain concepts to guide changes. A full DDD layer conversion, generic repository framework or directory rewrite requires its own scoped issue, acceptance criteria and behavior-preserving tests.

## Tests

Agree on public test interfaces before adding a new kind of test. The initial interfaces are HTTP auth, roles and order lifecycle; Socket.IO regional notifications; and public region-matching functions.

Assert what callers observe through those interfaces. Use real internal modules and a disposable database. Fixtures may insert setup data directly; behavior assertions use public interfaces. Mock only external system boundaries when needed. Prefer literal expected values based on a requirement or worked example. Avoid internal call counts, private-method assertions and expected values recomputed with the production algorithm.

Name the outcome. Keep each test focused on one behavior, with the assertions needed to establish it. For new behavior, show a failing test before the minimal implementation, one vertical slice at a time. For inherited behavior, capture a baseline before conversion and demonstrate that a deliberate regression makes the test fail. Restore the implementation after that check.

A test that still passes when its named behavior breaks must be fixed before merging. Keep broader refactors separate from feature implementation. Document coverage limits and known gaps rather than encoding unwanted behavior as a passing requirement.
