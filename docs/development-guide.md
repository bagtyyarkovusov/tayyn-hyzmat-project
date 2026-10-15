# Development and deployment guide

## Current infrastructure

- Private repository: https://github.com/bagtyyarkovusov/tayyn-hyzmat-project
- Railway project: https://railway.com/project/09e47dfb-3071-43b3-83f2-30fe8c69bb75
- Environment: `development`. This contains fresh test data, not an imported production database.
- Web: https://web-development-d17b.up.railway.app
- Services: `web`, `api`, `Postgres`. Only web needs a public HTTP domain. PostgreSQL's Railway template also supplies a TCP connection endpoint.

## How requests work

The browser loads Vue from nginx. Requests under `/api/` go to Express; nginx removes the `/api` prefix. `/socket.io/` proxies realtime traffic with WebSocket upgrades. On Railway, nginx reaches `http://api.railway.internal:4000`. On Compose, it reaches `http://api:4000`. Only `API_UPSTREAM` changes at runtime, so the same web image can serve either environment.

The web build has `VUE_APP_API_URL=/api` and `VUE_APP_SOCKET_URL=/`. `VUE_APP_YANDEX_MAPS_API_KEY` is an optional public build argument. Without it, Yandex-dependent map screens may be unavailable. Browser keys must be restricted to your test/production domains. Never put backend secrets into Vue variables.

## Railway configuration

API source root is `/backend`, with its `Dockerfile`. The web source root is the repository root, with `deploy/Dockerfile.web`. Both services check `/health`. API pre-deploy command is `npx prisma migrate deploy`; this applies checked-in migrations, never development schema generation.

API variables: `NODE_ENV=production`, `PORT=4000`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, separate random JWT secrets, `CORS_ORIGIN` set to the test web origin, and fresh seed admin values. Web variables: `PORT=8080`, `API_UPSTREAM=http://api.railway.internal:4000`. Service settings currently live in Railway; the old railway.json config mechanism is deprecated by the platform. Reproduce settings from this guide if creating another project.

The API runs in production mode for realistic behavior while the Railway environment is named development. These names have different meanings.

## First test walkthrough

1. Open `/adminLogin` on the test web domain. Read `SEED_ADMIN_PHONE` and `SEED_ADMIN_PASSWORD` in local `.env` or Railway API Variables.
2. In a separate browser profile, open `/driverRegister` and register a synthetic driver. Use invented names and phone numbers.
3. Approve the driver in the admin panel. Log in as that driver and set a district, vehicle and online status as the screens require.
4. Create a test order from the admin panel. Check order visibility, acceptance, waiting, trip start and completion.
5. Exercise admin-driver chat and location updates. Browser geolocation requires permission and HTTPS outside localhost.
6. Record any failure with the route, expected result and actual result before changing application logic.

## Local development

Use Docker Compose for the complete reproducible environment. For frontend hot reload, run `npm ci` then `NODE_OPTIONS=--openssl-legacy-provider npm run serve` with Vue API/socket variables targeting a reachable backend. Root `.npmrc` handles existing peer conflicts. Backend hot reload needs `backend/.env`, `npm ci` in backend, Prisma generation and a reachable test database. Avoid pointing local development at existing live data.

Local credentials are in `.env`, which is ignored and mode 0600. They are separate from the source archive's credentials. Do not paste that file into issues or commits. Android signing keys remain in the original recovered folder and were excluded from the new repository.

## Container release and VPS handoff

The `Publish container images` GitHub Action is manual or triggered by a `v*` tag. It publishes `ghcr.io/bagtyyarkovusov/tayyn-hyzmat-project-web` and `...-api`, for amd64 and arm64, with full Git SHA tags. Keep packages private unless publication is intentional. Pulling private images from GHCR requires registry credentials on the VPS. Railway builds from private GitHub source, avoiding a Railway Pro upgrade for private image pulls.

For a release, run the publishing workflow, inspect the successful build and capture each digest. Set `WEB_IMAGE` and `API_IMAGE` in the VPS environment to their `ghcr.io/...@sha256:...` references. Use `docker compose pull` and `docker compose up -d --no-build`; these reuse built images and run migrations before API startup. The supplied Compose file binds web to `127.0.0.1:8080` and keeps database/API ports private. Add a VPS reverse proxy with HTTPS, DNS and WebSocket forwarding before public access. Do not seed with default credentials.

Database data is separate from images. Use PostgreSQL native exports for transfer, verify restoration in a separate database, schedule off-host backups, and agree on acceptable downtime before migration. Railway backups cannot directly restore into a VPS. Match PostgreSQL major versions or validate a supported logical restore. The local Compose default is PostgreSQL 17.

Rolling back an image does not roll back schema or data. Review migration compatibility before each release. A single VPS needs monitoring, security updates, disk alerts and a tested restore procedure. VPS selection, domain, access, backup targets and production release approval remain future decisions.

## Review after the environment works

Start with the intended users and exact test acceptance criteria, then settle which customer flow remains, dispatch rules, fares/commission, driver device approval, maps and notifications. Choose the MVP before modernizing dependencies or changing the schema. Production security and operational acceptance follow after that scope is clear.
