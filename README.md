# Tayyn Hyzmat

Dispatcher and driver pilot for regional order dispatch. A dispatcher selects a region, available drivers receive offers, and a driver claims and completes an order. Development uses synthetic balances, no real payments and TMT only.

The active browser apps use Vue 3, Vite, strict TypeScript and official shadcn-vue components. Express, PostgreSQL, Prisma and Socket.IO power the API. pnpm 10.33.2 manages the workspaces; Docker images are the deployment unit. The inherited customer app remains available at `/legacy/`.

Start with [contributor commands](CONTRIBUTING.md), [isolated development](docs/development.md) and [product scope](docs/product.md). Architecture and limits are in [architecture](docs/architecture.md); checks are in [testing](docs/testing.md); implementation rules are in [coding standards](docs/coding-standards.md). [GLOSSARY](GLOSSARY.md) defines domain terms and [ADRs](docs/adr/) record architectural decisions. Track work through [GitHub Issues](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm preview:isolated
```

The preview creates its own synthetic database and prints its loopback URL. Its ignored `.local/browser-context.json` contains actor credentials. Stop it with Ctrl-C to clean up. No Railway access is required. `main` automatically deploys shared Railway, where a supporting developer edits real regions; keep test data and feature work isolated.

Production VPS setup and release gates are documented in [production handoff](docs/production-handoff.md). Railway remains the shared development environment.

Original documentation is preserved intact in `archive/documentation-2026-10-15.tar.gz`, with a SHA-256 manifest. It is historical reference, not current agent instructions.

Derived from [majordomo-consulting/openride](https://github.com/majordomo-consulting/openride). See [LICENSE](LICENSE) for GPL-3.0 terms. shadcn-vue component sources retain their upstream MIT terms; see [third-party notices](docs/third-party-notices.md).
