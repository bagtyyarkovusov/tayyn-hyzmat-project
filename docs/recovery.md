# Recovery record

Recovered on 2026-10-15 from `/Users/bagtyyar/Projects/tayyn-hyzmat-project `, whose name ends with a space. The T3 workspace without that space was empty. A matching archive extraction is also in Downloads.

The original folder is unchanged. Its Git remote is https://github.com/majordomo-consulting/openride and its last commit is `d77346797606f6e5cf316cbaa8ceeeac36b2f3f8`. Local application additions were recovered from the working tree, including the Express backend and newer admin/driver panels. New history excludes the upstream repository's tracked node_modules, generated bundles, environment files and Android signing material. GPL-3.0 license and original attribution are retained.

Recovery changes are limited to deployment support: Dockerfiles, nginx proxy, Compose, examples, docs and an image publishing workflow. `.npmrc` preserves legacy peer dependency resolution. The webpack 4 build uses OpenSSL's legacy provider during compilation. Existing seed code no longer logs the admin password. Three hardcoded legacy Airtable token occurrences were replaced with inert markers before publishing source or browser bundles.

No existing database was imported. Railway has a fresh development database. Existing environment secrets and signing keys remain only in the original folder. Fresh development secrets are generated separately in the ignored local `.env`.

The customer screens still contain the upstream Firebase configuration and old Airtable integration. Do not treat those screens as recovered customer functionality. Use the new admin/driver flow for the first test. Isolating or replacing the legacy integrations is an explicit topic for the product review.
