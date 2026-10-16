# Development environments

Use synthetic data. The supporting developer's region editor and shared Railway database must remain separate from our fixtures and automated tests.

## Isolated local pilot

The isolated Compose project is `tayyn-zone-test`, with a dedicated database and volume, available at http://localhost:8081. Its ignored credentials are in `.local/zone-test.env`. Existing setup commands are:

```sh
docker compose -p tayyn-zone-test --env-file .local/zone-test.env -f compose.yaml -f deploy/compose.zone-test.yaml up -d --no-build
docker compose -p tayyn-zone-test --env-file .local/zone-test.env -f compose.yaml -f deploy/compose.zone-test.yaml run --rm --no-deps seed-zone
TEST_BASE_URL=http://localhost:8081 node --env-file=.local/zone-test.env scripts/smoke.mjs
```

`--no-build` uses existing local images. To test a changed image, give it a separate tag and an isolated Compose override before restarting this stack. The base Compose file shares image names with another local environment.

The fixture in `scripts/seed-zone-test.cjs` creates `TEST ONLY - Central Ashgabat` centered on 37.9601, 58.3261, with a guessed rectangular boundary. It creates one dispatcher and three approved drivers. It is not the supporting developer's actual region drawing. Passwords come from the ignored environment file. Seeding preserves existing balances and edits.

Fresh checkouts need a private `.local/zone-test.env` based on `.env.example` and the variables referenced by the zone override. Generate independent JWT secrets and seed passwords, retain database name `tayyn_zone_test`, and keep `ISOLATED_ZONE_FIXTURE=true` only for this fixture. The shared root `.env` is not a substitute.

## Railway

The shared development URL is https://web-development-d17b.up.railway.app. GitHub pushes merged into `main` trigger automatic Railway builds. Feature branches do not deploy this shared environment. The API builds from `backend/`, runs Prisma migrations before deployment, and connects to Railway PostgreSQL. The web builds with `deploy/Dockerfile.web` and proxies to the API.

Configure secrets in Railway variables and ignored local environment files. The Yandex Maps key is a browser build variable, `VUE_APP_YANDEX_MAPS_API_KEY`, so changes require a web rebuild. API JWT secrets stay on the backend. Never copy development database contents into production.

## Mobile and production

Start with the driver app in a mobile browser. Loopback port 8081 is only reachable on this computer. Physical-phone GPS testing needs an isolated HTTPS URL and API proxy, which has not yet been provisioned.

Production will use Docker images on a VPS. The existing `container-images.yml` workflow publishes web and API images to GHCR on version tags or manual dispatch. Production secrets, TLS, backups, restoration and a verified VPS rollout remain deployment work. Railway development is not production readiness evidence.

## Modernization preview

Use `pnpm preview:isolated` in the modernization worktree. It creates a new tmpfs PostgreSQL container and real API/frontend on random loopback ports, without reading the original worktree environment. It seeds canonical saved regions plus synthetic accounts; existing preview instances are disposable. Inspect ignored `.local/browser-context.json` for current actor URLs and synthetic credentials. Leave the command running while reviewing and stop it with Ctrl-C afterward. This preview is independent of the older zone-test stack above and shared Railway.

The modern app uses `VITE_API_URL`, `VITE_SOCKET_URL` and `VITE_YANDEX_MAPS_API_KEY`; existing `VUE_APP_*` names remain supported for Docker/Railway build compatibility. Configure a development-restricted map key separately if live vendor rendering is needed. With no key, lists, region selection and explicit coordinate editing remain available. The disposable suite intentionally supplies no map key.

## Default region geometry

New environments use the finalized versioned [canonical regions](regions.md). The shared Railway editor already stores them. The old isolated rectangle remains only an explicit edge-case fixture.

To keep an already selected loopback URL after restarting your own preview, set `TAYYN_PREVIEW_API_PORT` and `TAYYN_PREVIEW_WEB_PORT` when using `--serve`. Occupied ports fail rather than replacing another service.

## Android driver

See [Android testing](android.md) for the native shift service, explicit HTTPS build endpoints, isolated backend/CORS setup and device release gates. Browser GPS remains foreground-only.
