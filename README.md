# Tayyn Hyzmat

Dispatcher and driver pilot for Ashgabat. Dispatchers create orders in a region and drivers receive live offers. Development uses synthetic accounts and TMT balances, with no real payments.

Vue 2 serves the dispatcher and driver browser apps. Express, Socket.IO, Prisma and PostgreSQL run the backend. Backend TypeScript adoption has started with region matching. See [architecture](docs/architecture.md) for the current limits.

## Start here

1. Read [development](docs/development.md) for the isolated local environment and Railway deployment flow.
2. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for installation and checks.
3. Read [product scope](docs/product.md), [testing](docs/testing.md) and [coding standards](docs/coding-standards.md) before changing behavior.

[Domain vocabulary](GLOSSARY.md) defines the terms. [Architectural decisions](docs/adr/) record settled choices. Work is tracked in [GitHub Issues](https://github.com/bagtyyarkovusov/tayyn-hyzmat-project/issues).

## Previous documentation

Eight original documents are preserved intact in `archive/documentation-2026-10-15.tar.gz`, including a SHA-256 manifest. View the contents with `tar -tzf archive/documentation-2026-10-15.tar.gz`. Extract to a temporary directory when consulting history. Archived instructions are historical, not current project guidance.

This project derives from [OpenRide](https://github.com/majordomo-consulting/openride). It retains the [GPL-3.0 license](LICENSE).
