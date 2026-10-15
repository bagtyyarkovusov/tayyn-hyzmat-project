# Canonical region defaults

`backend/prisma/data/default-regions.json` is the versioned bootstrap dataset for all nine operational dispatch regions finalized by the supporting developer on 2026-10-15. It was exported through the shared development API after the owner confirmed the drawing was complete. The file contains IDs, names, centers, radii and 216 polygon coordinate pairs. Coordinates are `[latitude, longitude]`, not GeoJSON.

These are dispatch regions, not official administrative boundaries. Geometry is copied exactly from the saved editor response. No live accounts, orders, tokens or passwords are included. Tariff defaults remain in the seed implementation; this export does not approve a new pricing policy.

## New environments

After applying schema migrations, `npm --prefix backend run seed` creates the administrator and these regions. To seed only the regions, use `npm --prefix backend run seed:regions`. In the pnpm modernization workspace, use the equivalent backend workspace script. Both are explicit bootstrap commands, not an automatic reset on application startup.

The region import runs in a transaction. It creates missing regions and fills null boundaries on existing named regions. It preserves existing IDs, configured values and non-null boundaries. Identity conflicts stop the transaction for manual inspection. Running the command again preserves subsequent editor changes.

## Existing environments

Shared Railway already contains the exported boundaries and needs no write or deployment to preserve them. Other existing environments can run the region-only command against their intended database after checking the connection. Existing non-null geometry takes precedence, even when it differs from these defaults. Replacing such geometry requires a separately reviewed operation; this seed never forces replacement.

Use canonical defaults for representative local previews and future deployment bootstrap. Automated geometry edge-case tests may deliberately use small synthetic polygons. The original `tayyn-zone-test` fixture remains an explicitly separate guessed test rectangle; it is not the canonical map and is not intended to mirror the real region set.

## Future changes

Save the editor changes first, export a fresh region-only response, validate the geometry, and review the JSON diff before updating this file. An updated repository default affects future bootstrap operations; it does not silently synchronize or overwrite running environments. Commit history preserves earlier approved versions.

The captured file SHA-256 is `ccdd98348545ac81394d39c0892c2d3eeae9c26ebc42cd3b1bf1d209ea3cd710`. This export is region configuration, not a full PostgreSQL backup.
