# Production release records

Each production VPS release gets one record in this directory, named after its semantic version (for example `v1.20.1.md`). The record maps the immutable offline bundle name to the semantic version tag.

## Convention

- Offline bundles stay named `vps-N-<full commit>`. Images inside them use `tayyn-offline/<role>:vps-N-<full commit>`. These names are never renamed or reused.
- The production merge commit is tagged `vX.Y.Z`. The tag is an alias for that commit, never a replacement for the `vps-N` name.
- Major and minor follow the Android `versionName` that drivers have installed (for example `1.20`). A server or dashboard release without a new APK increments the patch number. A new APK `versionName` starts a new minor at patch 0.
- Pushing the `vX.Y.Z` tag runs `container-images.yml`. It publishes GHCR web and API images tagged `vX.Y.Z` and `sha-<full commit>`. The `sha-` tag matches the commit in the `vps-N` name.
- Dispatch `offline-production-bundle.yml` from the tag ref so `manifest.json` records `"version": "vX.Y.Z"` alongside `sourceCommit`. When building manually, pass `--version vX.Y.Z` to the exporter.

## Template

```markdown
# vX.Y.Z

| Field         | Value                                |
| ------------- | ------------------------------------ |
| Version tag   | `vX.Y.Z`                             |
| VPS release   | `vps-N-<full commit>`                |
| Source commit | `<full commit>`                      |
| Pull request  | #NNN                                 |
| Deployed      | YYYY-MM-DD                           |
| Android app   | X.Y (no new APK, or new APK code NN) |
| Release notes | [link](../<notes>.md)                |

## Notes

Deviations, manual steps and verification evidence.
```
