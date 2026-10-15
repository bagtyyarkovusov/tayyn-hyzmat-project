# Isolated zone testing

Open http://localhost:8081/adminLogin for the dispatcher, or http://localhost:8081/driverLogin for drivers on this computer. This is a separate local environment. It is not the shared Railway development environment or the original local stack on port 8080.

Compose project `tayyn-zone-test` has its own network, database `tayyn_zone_test` and named volume `tayyn-zone-test_postgres-data`. It reuses the existing application images without rebuilding them. No shared region records are read or changed. The only database modified by the fixture is the isolated database.

The fixture contains one region named `TEST ONLY - Central Ashgabat`, centered at 37.9601, 58.3261. Its guessed rectangle spans latitude 37.94–37.98 and longitude 58.30–58.36. It is a convenient test area, not a surveyed or official boundary. Rates are synthetic defaults: base 5 TMT, 1.5 TMT/km and 0.3 TMT/min.

One synthetic dispatcher and three approved drivers are available. Administrator credentials are in the ignored `.local/zone-test.env`. Driver phones are `+10000000101`, `+10000000102`, `+10000000103`; they share `SEED_DRIVER_PASSWORD` from that file. Each starts with 500 synthetic TMT. They start offline with no reported GPS position. No real payment provider is connected.

Run from the repository root:

```sh
docker compose -p tayyn-zone-test --env-file .local/zone-test.env -f compose.yaml -f deploy/compose.zone-test.yaml up -d --no-build
docker compose -p tayyn-zone-test --env-file .local/zone-test.env -f compose.yaml -f deploy/compose.zone-test.yaml run --rm seed-zone
```

The fixture checks the database name and internal hostname before writing. Reruns preserve existing geometry, passwords and balances. It does not overwrite later manual edits. To run the existing smoke check using these credentials:

```sh
TEST_BASE_URL=http://localhost:8081 node --env-file=.local/zone-test.env scripts/smoke.mjs
```

Use separate browser profiles for dispatcher and driver sessions. A mobile viewport on this computer works at port 8081. A physical phone cannot access this loopback-only address; a separate HTTPS tunnel or isolated hosted environment is needed for phone testing, particularly geolocation. No shared Railway deployment was changed to expose this fixture.

Stop only this stack with:

```sh
docker compose -p tayyn-zone-test --env-file .local/zone-test.env -f compose.yaml -f deploy/compose.zone-test.yaml down
```

Keep the volume to retain fixtures and edited test geometry. The application still has the region-claim and nearest-center fallback limitations recorded in [pilot decisions](pilot-decisions.md).

## Verification record

The isolated stack passed the health/login/database/role/WebSocket smoke check. A separate synthetic order was created by the dispatcher in the test zone; driver 1 received `order:new` over WebSocket and completed acceptance, waiting, start and completion. Its fake balance changed from 500 to 490 TMT for the 10 TMT test order. The other two drivers retain 500 TMT. This leaves one clearly marked completed synthetic order for inspection. No real money changed hands.

Fixture files are on branch `dev/isolated-zone-test`, rather than `main`, so this work does not trigger shared Railway deployments while region editing continues.
