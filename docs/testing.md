# Testing

Use Node.js 22. The initial public test interfaces are HTTP for authentication, roles and the order lifecycle, Socket.IO for regional notifications, and the exported region-matching functions. These were selected for the dispatcher-driver pilot. Follow [coding standards](coding-standards.md) when adding tests.

## Commands

```sh
npm run typecheck
npm run test:unit
npm run test:integration
```

Typecheck builds the backend, then checks the TypeScript module and tests. Unit tests need no database. Integration tests require Docker and exercise the compiled API with real Express, Prisma and Socket.IO modules.

`scripts/test-backend.mjs` creates a uniquely named PostgreSQL 17 container with random credentials and a random loopback port. It replaces any inherited `DATABASE_URL`, applies all migrations, runs synthetic fixtures and tests, then removes only the container it created. It never attaches to the existing Compose stacks or Railway. The container uses no persistent named volume.

Fixtures insert initial accounts and regions directly. Behavior assertions use HTTP responses, socket events and the public geometry interface. No internal services are mocked. Each integration test resets order and balance fixtures; tests run sequentially within one disposable application instance.

## Current coverage

- Authentication and admin-role access control.
- Pending driver registration, approval and login.
- Order claim, waiting, start and completion, including invalid transitions.
- One winner when two drivers claim the same order.
- Quoted synthetic TMT charge, no second completion charge, cancellation refund and sequential duplicate rejection.
- Dispatcher cancellation refund, exact PAYMENT/REFUND ledger signs and notes, and no ledger writes for missing or non-positive inherited quotes.
- Region notification delivery, customer-phone redaction, and suppression for another region or an offline driver.
- Polygon matching, overlaps, nearest-center fallback, empty configuration and a known distance example.

These tests capture inherited behavior before further changes. Removing the polygon match made the unit suite fail. Removing the acceptance charge made the lifecycle and refund tests fail. Both deliberate regressions were restored. An invalid coordinate type was also used to verify compiler rejection.

Before extracting the order-charge module, the dispatcher refund and missing/non-positive quote tests passed against the original implementation. Removing the dispatcher's refund call failed the new test with balance `490` instead of `500`; restoring it and extracting the module passed all tests. Zero and negative quote fixtures represent inherited database values because order creation rejects those prices over HTTP.

Negative notification assertions observe a short bounded delivery window after a successful request. They cover live local sockets, not background delivery guarantees. No browser automation, phone GPS, real Yandex requests, push delivery, or load tests are included. Concurrent cancellation and multiple simultaneous orders for one driver need separate tests and review.

Cross-region claiming remains a known gap in [issue #1](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues/1). The suite does not encode that unwanted behavior as a passing requirement. It must gain a failing public HTTP test before the rule is changed.

## CI

`.github/workflows/checks.yml` runs backend build, typecheck, unit and disposable-database tests, builds the API Docker image, and builds the web Docker image. CI runs on pull requests and pushes to `main` or `dev/**`. Repository branch protection must separately require these checks if merge gating is desired.
