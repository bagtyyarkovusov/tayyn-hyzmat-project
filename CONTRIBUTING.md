# Contributing

Use Node.js 22.12 or later, pnpm 10.33.2 and Docker. Enable the pinned manager with `corepack enable`, then run:

```sh
pnpm install --frozen-lockfile
pnpm --filter openride-backend prisma:generate
pnpm typecheck
pnpm format:check
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm build:driver
```

Database tests create fresh PostgreSQL containers with random names, loopback ports and secrets. They overwrite supplied database URLs and remove only their own container. Browser tests run real HTTP and Socket.IO against the compiled API. See [testing](docs/testing.md).

Use `pnpm dev` for the frontend and `pnpm --filter openride-backend dev` for the API. The default frontend proxy expects an API on loopback port 4185; set `TAYYN_TEST_API` for another isolated endpoint. Never point fixtures or tests at Railway. `pnpm preview:isolated` creates a disposable synthetic environment and keeps it running until stopped, with URLs and synthetic credentials in ignored `.local/browser-context.json`.

The production build includes modern dispatcher/driver apps and a separate `/legacy/` compatibility app. `pnpm build:modern` excludes compatibility for quick iteration. Backend Docker remains independently buildable with its checked-in standalone pnpm lock; update both lockfiles when changing backend dependencies using `pnpm install` at root and `pnpm --dir backend install --lockfile-only --ignore-workspace`.

Create a focused feature branch and link the GitHub issue in the PR. Explain behavior changes and verification. Follow [coding standards](docs/coding-standards.md). `main` deploys shared Railway, where another developer edits real regions. Do not merge or deploy modernization while that work is active. Preserve Docker startup and run container builds when changing tooling.
