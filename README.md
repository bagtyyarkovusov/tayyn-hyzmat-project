# Tayyn Hyzmat

Taxi dispatch software for Ashgabat. The recovered app has a Vue 2 web interface, a separate Capacitor Android driver app, and a Node.js API backed by PostgreSQL. The admin panel handles drivers, districts, orders, balances, chat and location monitoring. Driver accounts require administrator approval.

The current goal is a working development environment on Railway, followed by a product and architecture review. Production is planned as Docker images deployed to a VPS.

## Project map

| Path | Purpose |
| --- | --- |
| `src/admin/` | Dispatcher and administrator screens |
| `src/driver/` | Driver screens |
| `src/services/`, `src/store/` | API clients, realtime connections and browser state |
| `src/components/` | Shared and legacy customer components |
| `backend/src/` | Express API, authentication, order logic and Socket.IO |
| `backend/prisma/` | Database schema, migrations and bootstrap data |
| `android/` | Capacitor native driver project |
| `deploy/` | Web image and nginx reverse proxy |
| `compose.yaml` | Local containers and future VPS deployment base |
| `.github/workflows/` | Versioned, multi-architecture image publishing |
| `docs/` | Research, recovery notes and setup guide |

## Start here

Read [the setup guide](docs/development-guide.md), [recovery notes](docs/recovery.md), and [deployment research](docs/deployment-research.md). The detailed [backend API documentation](backend/README.md) is retained in Russian.

Docker Desktop must be running. Fresh local secrets have been generated in `.env` during recovery. For another checkout, copy `.env.example` to `.env` and replace all password/secret placeholders first. Use URL-safe hexadecimal values for the PostgreSQL password because Compose embeds it in a connection URL.

```sh
docker compose build api web
docker compose up -d
# One-time bootstrap of the local database:
docker compose run --rm api node prisma/seed.js
```

Open http://localhost:8080/adminLogin or http://localhost:8080/driverLogin. The development administrator phone and password are in the local `.env`. Railway uses the same development administrator credentials stored in Railway variables.

```sh
docker compose ps
docker compose logs --tail=100 api web
docker compose down
```

`down` retains database data. Never use `down -v` unless you intend to erase that data.

## Known limits

Vue 2 and Vue CLI 4 are old and have dependency vulnerabilities. The customer flow still depends on the upstream Firebase/Airtable design. Driver push token registration exists, but server push delivery is incomplete. `/health` checks process availability, not database readiness. Keep a single API replica because Socket.IO rooms and presence are held in memory. Production readiness is a later phase.

## License and origin

Derived from [OpenRide by Majordomo Consulting](https://github.com/majordomo-consulting/openride), with recovered Tayyn Hyzmat changes. Distributed under [GPL-3.0](LICENSE). See [recovery provenance](docs/recovery.md).
