# Deployment research

Researched 2026-10-15 against Railway, GitHub and Docker documentation. This is a deployment plan, not a claim that an environment has already been deployed.

## What we know about this project

The recovered source has a Vue 2 / Vue CLI 4 frontend, a separate driver HTML bundle, an Express API using Socket.IO and JWT, and Prisma 5 with PostgreSQL. The frontend still contains Firebase and Airtable integrations. Recovering those integrations and their data is a separate task from starting the new API. Evidence: root `package.json`, `vue.config.js`, `backend/package.json`, `backend/README.md` and `src/services/`.

The API already reads environment variables and handles shutdown signals. Its Prisma migrations live in `backend/prisma/migrations`. The browser API and socket URLs default to `http://localhost:4000`, so a remote deployment must override those defaults. `VUE_APP_*` settings are compiled into the browser bundle; changing a Railway runtime variable after building does not rewrite an existing static bundle. Evidence: `src/services/apiClient.js`, `src/services/adminApiClient.js`, `src/services/socketClient.js`, `backend/src/server.js` and [Vue CLI environment variables](https://cli.vuejs.org/guide/mode-and-env.html#environment-variables).

The seed script has a known default administrator password. Set a unique `SEED_ADMIN_PASSWORD` before seeding; treat seeding as a deliberate initial setup operation rather than an automatic action on every deployment. Evidence: `backend/prisma/seed.js`.

## Recommended route

Use a private GitHub repository as the source, a Railway `development` environment for testing, and Docker Compose on a VPS for production. Start with three Railway services: static web, API and PostgreSQL. Keep the API at one replica because socket presence and room broadcasts currently live in one process. Redis becomes necessary if that architecture later scales horizontally. Evidence for the socket constraint: `backend/README.md`.

Build the web and API from checked-in Dockerfiles on Railway. Publish versioned images to GitHub Container Registry when preparing VPS releases. That path works without upgrading solely for private registry access: Railway can build GitHub source, while pulling a **private registry image requires Pro**. If we later require Railway to test the exact published private image digest used on the VPS, plan for Pro. Do not make images public just to bypass this limit. Sources: [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [service sources](https://docs.railway.com/services), [private registries](https://docs.railway.com/builds/private-registries).

Source builds using the same Dockerfile are useful for recovery, but separate builds are not proof of identical images. The eventual release flow should build once, test that image, record its digest, and promote that digest to production.

## Runtime and deployment requirements

| Topic | Verified behavior and recommendation |
| --- | --- |
| Dockerfile selection | Railway detects a capitalized `Dockerfile` in the source root; a custom path is supported. Give web and API separate Dockerfiles and explicit build contexts. [Source](https://docs.railway.com/builds/dockerfiles) |
| HTTP port | Listen on Railway's `PORT` and a reachable interface such as `0.0.0.0`. The port used by the web server, domain target and healthcheck must agree. Provide an explicit default for local Compose. [Sources](https://docs.railway.com/deployments/healthchecks), [binding guidance](https://docs.railway.com/guides/vibe-coding-deploy#hardcoded-ports) |
| Frontend routing | Serve the built `index.html` and `driver.html` with their own route fallbacks. Prefer same-origin `/api` and Socket.IO proxying so the web image can move between environments without embedding a Railway hostname. This is a recommendation based on the current two-entry build, not an existing verified deployment. |
| Healthchecks | Configure readiness endpoints. The current reference accepts any `2xx`; some guide snippets still mention only `200`, so returning `200` avoids that discrepancy. Railway checks at deployment time only, with a default 300-second timeout. Add independent uptime monitoring later. [Source](https://docs.railway.com/deployments/healthchecks) |
| Database migrations | Run committed migrations as a controlled release step using `npm run prisma:deploy`, not interactive `prisma migrate dev`. Database access is unavailable over Railway private networking during image build. Ensure the release image contains the Prisma CLI if it must run migrations. [Railway network source](https://docs.railway.com/networking/private-networking/how-it-works), [Prisma production guidance](https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production) |
| Environment separation | Railway environments isolate services and configuration; private networks are isolated per project and environment. Give development its own database, secrets and test users. Do not reuse production credentials through a copied public connection URL. [Sources](https://docs.railway.com/environments), [private networking](https://docs.railway.com/networking/private-networking/how-it-works) |
| API networking | Keep PostgreSQL private. On the VPS, expose the reverse proxy over HTTPS and keep API/database traffic on the Compose network. Support Socket.IO upgrades and verify login, reconnect and events through the proxy. This is the proposed network layout. |

## Data, backups and secrets

Container images package code and dependencies; they do not replace a database backup or an upload migration. Mount persistent database storage on Railway and a named database volume on the VPS. Keep uploaded files outside disposable container layers. Railway allows one volume per service, disallows replicas for volume-backed services, and documents brief redeployment downtime for these services even with healthchecks. Sources: [Railway volumes](https://docs.railway.com/volumes/reference), [Docker volumes](https://docs.docker.com/engine/storage/volumes/).

Enable scheduled Railway volume backups before relying on test data. The reference currently documents daily retention of 6 days, weekly retention of 27 days, and monthly retention of 89 days. Restores are restricted to the same project and environment. For migration to the VPS, use database-native exports and restore tests rather than assuming a Railway snapshot is portable. Keep encrypted backups outside the VPS and define acceptable data loss and restore time. Sources: [Railway backups](https://docs.railway.com/volumes/backups), [PostgreSQL backup and restore](https://www.postgresql.org/docs/current/backup.html).

Keep JWT secrets, database passwords, registry credentials and administrator seed credentials out of Git, Docker images and frontend variables. Commit only `.env.example` placeholders and exclude real environment files from Docker build contexts. Runtime environment injection works across Railway and Compose. When a build truly needs a secret, use build secret mounts; Docker documents that build arguments and environment variables are inappropriate for secrets because they can persist in images. Sources: [Docker build secrets](https://docs.docker.com/build/building/secrets/), [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

## Container publication and VPS handoff

1. Build web and API images in GitHub Actions after the appropriate checks pass. Use `GITHUB_TOKEN` with the necessary package permissions for publication, rather than a long-lived personal publishing token. Pin third-party Actions to reviewed commit hashes. [GitHub publication guide](https://docs.github.com/en/actions/use-cases-and-examples/publishing-packages/publishing-docker-images).
2. Give each image a full commit tag such as `sha-<commit>` and release tags such as `v0.1.0`. Record `ghcr.io/<owner>/<image>@sha256:<digest>` in the production release configuration. Tags can move; digest references identify the image content. GHCR supports independent package visibility and digest pulls. [GHCR reference](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
3. Confirm the VPS CPU architecture. Include `linux/amd64` for Railway; an Apple Silicon build must not accidentally publish only ARM. Build `linux/arm64` as well if the VPS uses ARM. A multi-platform image index selects the corresponding platform image; testing the AMD64 variant does not test ARM binaries. [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/), [Railway architecture guidance](https://docs.railway.com/guides/private-container-registry#troubleshooting).
4. Supply a production Compose file referencing published digests, an example environment file, reverse-proxy configuration, a database backup/restore procedure and a short release/rollback runbook. Provision registry read access on the VPS if images are private. Docker documents Compose as a suitable single-server deployment option. [Compose production guide](https://docs.docker.com/compose/how-tos/production/), [GHCR authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry).
5. Back up before schema changes, pull the recorded images, apply compatible migrations, start services and verify readiness plus a real user flow. Retain the previous release's digests. Reverting the application image does not undo database migrations; a rollback decision must account for schema compatibility. This is the recommended operational procedure.

## Railway costs and limitations

At research time, Hobby costs $5/month with $5 included resource usage, and Pro costs $20/month with $20 included usage. These are not fixed-price unlimited servers. CPU, memory, egress, persistent storage and incremental backups affect the bill. Current published usage rates include memory at $10/GB-month, CPU at $20/vCPU-month, egress at $0.05/GB and volumes at $0.15/GB-month. Confirm the actual workspace plan and current pricing before provisioning. Sources: [plans and rates](https://docs.railway.com/pricing/plans), [backup billing](https://docs.railway.com/volumes/backups).

Set a usage alert and choose a compute hard limit with the owner. A hard limit can take every workload in that billing scope offline; it is an intentional outage tradeoff. Avoid adding many preview databases until their costs are understood. Prefer private database networking to avoid unnecessary egress. Source: [cost control](https://docs.railway.com/pricing/cost-control).

## Questions to resolve after recovery

- Which user flows must work before the Railway environment counts as recovered: administrator, driver, customer, Android, or all of them?
- Where are the existing PostgreSQL data, Firebase project, Airtable base and any uploaded files, and which should be copied into development?
- What monthly Railway budget is acceptable, and who owns GitHub, Railway billing and the future VPS?
- What VPS architecture, memory, region and domain are planned? What data-loss window and restore-time target are acceptable?
- Should development automatically follow a GitHub branch, and what checks will gate a production release?

Some Railway search results pointed to guide pages that the fetch tool could not resolve. The core requirements above use the retrievable reference pages; the architecture guidance is cited to its official search result and Docker's platform reference.
