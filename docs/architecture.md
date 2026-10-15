# Architecture

The root `src/` is a Vue 2 application with dispatcher and driver entry points. `backend/src/` contains an Express API, domain-oriented service folders, Prisma database access and Socket.IO notifications. `backend/prisma/schema.prisma` and its migrations define persistence. Android wraps the browser app with Capacitor and is outside the first test phase.

HTTP routes validate input with Zod, authenticate JWTs, check roles and delegate to services. Socket.IO authenticates access tokens and places eligible drivers in region rooms. Dispatcher order creation sends `order:new` to the selected region, with the customer's phone withheld from drivers until acceptance.

Region matching first checks saved polygons, then falls back to the nearest center. Polygon coordinates use `[lat, lng]`, unlike GeoJSON. Only the outer ring is used. Overlaps resolve by nearest center. A point outside all polygons is still assigned by nearest center. Product policy for that case is unresolved.

The backend build compiles JavaScript and TypeScript into `backend/dist/`. Existing JavaScript remains unchecked. Region matching and the new tests use strict TypeScript. The Vue app remains JavaScript. This is an incremental migration, not full type safety across the application.

The web container serves the built app and proxies `/api` and `/socket.io` to the API container. Railway hosts development; Docker images are also the intended deployment unit for a future VPS.

## Known behavior requiring separate work

The claim endpoint currently accepts cross-region claims, tracked in [issue #1](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues/1), contrary to the agreed pilot policy. Some inherited comments incorrectly describe that restriction as enforced. Available-order browsing can also show another region.

Acceptance debits the full quoted order price from the driver's synthetic balance. Completion does not charge again; cancellation refunds it. The intended fare and driver-charge semantics need an explicit business decision before replacing this behavior.

`backend/src/modules/orders/order-charge.ts` owns the existing quoted-price debit/refund arithmetic and ledger writes. Acceptance and both cancellation paths call it inside their existing Prisma transactions, then use its returned balance for notifications. Callers retain eligibility, status and duplicate-operation checks. The module does not add concurrency guarantees or define a new payment policy.

Concurrency protection for competing claims on the same order uses a conditional update. Broader concurrent operations, including multiple orders for one driver and repeated cancellations, need separate review. Initial tests are a baseline, not proof of every financial invariant.

Inherited Firebase, analytics and other frontend dependencies remain. A later cleanup should trace actual usage before removal. Background browser notification delivery is not guaranteed by an active Socket.IO connection.

[Issue #2](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues/2) scopes a later assessment of domain boundaries. It does not authorize a full DDD rewrite.
