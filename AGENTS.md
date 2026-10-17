# Working in this repository

Read [product scope](docs/product.md) and [coding standards](docs/coding-standards.md) before implementation. Keep changes scoped to the issue. Broader restructuring belongs in a separate proposal.

The supporting developer edits real region boundaries in a shared environment. Use the isolated synthetic environment described in [development](docs/development.md). Keep fixture writes and automated tests isolated from shared databases. Merging to `main` triggers Railway deployment, so prepare changes on a feature branch.

For VPS installation, production updates, credentials, backups or monitoring, read [production operations](docs/production-handoff.md) before changing deployment files. Record operational changes and evidence there.

Run the relevant checks in [CONTRIBUTING.md](CONTRIBUTING.md). For backend changes, include typecheck, unit and disposable-database integration tests. Preserve the Docker startup path when changing build tooling.

## Agent skills

### Issue tracker

Use GitHub Issues in `bagtyyarkovusov/tayyn-hyzmat-project`. See [issue tracker](docs/agents/issue-tracker.md).

### Triage labels

Use the five default triage labels. See [triage labels](docs/agents/triage-labels.md).

### Domain docs

Use one root glossary and `docs/adr/`. See [domain guidance](docs/agents/domain.md).
