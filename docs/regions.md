# Canonical region defaults

`backend/prisma/data/default-regions.json` is the versioned bootstrap dataset for all nine operational dispatch regions finalized by the supporting developer on 2026-10-15. It was exported through the shared development API after the owner confirmed the drawing was complete. The file contains IDs, names, centers, radii and 216 polygon coordinate pairs. Coordinates are `[latitude, longitude]`, not GeoJSON.

These are dispatch regions, not official administrative boundaries. Geometry is copied exactly from the saved editor response. No live accounts, orders, tokens or passwords are included. Tariff defaults remain in the seed implementation; this export does not approve a new pricing policy.

## New environments

After applying schema migrations, `pnpm --filter openride-backend seed` creates the administrator and these regions. To seed only the regions, use `pnpm --filter openride-backend seed:regions`. Both are explicit bootstrap commands, not an automatic reset on application startup.

The region import runs in a transaction. It creates missing regions and fills null boundaries on existing named regions. It preserves existing IDs, configured values and non-null boundaries. The one spelling correction described below also applies during bootstrap when the canonical ID still has the known old name. Identity conflicts stop the transaction for manual inspection. Running the command again preserves subsequent editor changes.

## Existing environments

Shared Railway already contains the exported boundaries and needs no write or deployment to preserve them. Other existing environments can run the region-only command against their intended database after checking the connection. Existing non-null geometry takes precedence, even when it differs from these defaults. Replacing such geometry requires a separately reviewed operation; this seed never forces replacement.

Use canonical defaults for representative local previews and future deployment bootstrap. Automated geometry edge-case tests may deliberately use small synthetic polygons. The original `tayyn-zone-test` fixture remains an explicitly separate guessed test rectangle; it is not the canonical map and is not intended to mirror the real region set.

## Арчабил spelling correction

The owner-approved name is `Арчабил, Бекреве`. Its stable ID remains `6fd3ea19-bcf1-41b3-8af1-df94f62b5f2f`; no coordinates or boundaries changed. The forward data migration `20261017140000_archabil_region_spelling` changes only that ID when its name is exactly the old `Ачабил, Бекреве`. A custom name on the same ID, or an unrelated row with the old name, is left unchanged. The region seed accepts this same known spelling transition, including when bootstrap runs before the migration. Other identity conflicts still stop seeding for review.

If the spelling must be reverted, use a new reviewed forward migration with the same ID/name guards. Do not edit an applied migration or restore geometry from the defaults.

## Future changes

Save the editor changes first, export a fresh region-only response, validate the geometry, and review the JSON diff before updating this file. An updated repository default affects future bootstrap operations; it does not silently synchronize or overwrite running environments. Commit history preserves earlier approved versions.

The current file SHA-256 is `25769e1d09ca00a010fb1bbb20e71e4b59dd45082d9f8062220813f4f1c95793`. This export is region configuration, not a full PostgreSQL backup.
