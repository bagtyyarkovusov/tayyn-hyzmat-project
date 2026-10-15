# Contributing

Use Node.js 22 and Docker. Install both dependency sets with `npm ci` at the root and `npm ci --prefix backend`. Generate the database client with `npm --prefix backend run prisma:generate`.

## Checks

```sh
npm run build:backend
npm run typecheck
npm run test:unit
npm run test:integration
NODE_OPTIONS=--openssl-legacy-provider npm run build
```

Integration tests require Docker and create their own PostgreSQL container. They never use the shell's database URL. See [testing](docs/testing.md).

For backend development, run `npm --prefix backend run dev`. For compiled startup, run `npm run build:backend` followed by `npm --prefix backend start`. The Vue development server uses `npm run serve`; configure its API connection through the existing environment example.

Create a focused branch and link the GitHub issue in its pull request. Explain behavior changes and verification. Follow [coding standards](docs/coding-standards.md); keep unrelated refactors in separate issues. `main` deploys the shared Railway development environment.
