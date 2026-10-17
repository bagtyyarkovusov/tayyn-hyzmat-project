# Offline production bundle

This package targets Ubuntu 24.04 amd64. It separates connected build/download work from installation on the restricted VPS. No real bundle has been built or certified by adding these scripts. Clean-host rehearsal, credentials, TLS and physical-phone delivery remain release gates. See [production handoff](production-handoff.md) for environment ownership, Namecheap DNS and the operational checklist.

## Prepare packages on a disposable connected builder

Run this only in a fresh Ubuntu 24.04 amd64 builder. It installs repository tooling on that builder and downloads Docker Engine, Compose, containerd, age, Python and SSH/TLS dependencies.

```sh
sudo bash scripts/production/prepare-offline-packages.sh --disposable-builder /output/packages
sudo bash scripts/production/prepare-offline-packages.sh --disposable-builder /output/packages-monitor --monitor
```

The downloader uses an empty dpkg status database so dependencies already installed on the builder are still downloaded. It records package versions in `PACKAGES.tsv`. It does not prove those packages install on the purchased VPS. Before release, install the exact package set on a clean Ubuntu 24.04 amd64 VM with network disconnected. Reboot it, check Docker/Compose, age, Python, SSH and the complete app startup. Record the Ubuntu image version and evidence. A container-only test cannot prove kernel, systemd, firewall or reboot behavior.

The installer resolves ordering from explicit local `.deb` paths with `apt-get --no-download` and repository sources disabled. Missing dependencies stop installation. Existing conflicting Docker/containerd packages require operator review; the script never removes them. Do not run the downloader on production.

## Export already-built images

Build API/web offsite for `linux/amd64` using the checked-in Dockerfiles. The web build must receive the production public Maps key through `VUE_APP_YANDEX_MAPS_API_KEY`. The image workflow reads the GitHub repository variable `VUE_APP_YANDEX_MAPS_API_KEY`; configure and verify that variable before building a production web image. Confirm the resulting web app loads Yandex before exporting it. The API Geocoder key and Firebase service-account JSON are runtime secrets, supplied later through `/etc/tayyn/app.env`.

On a connected builder, load or pull reviewed image references. Pin API/web to a reviewed commit and infrastructure images to reviewed digests before calling the exporter. Example references below are placeholders.

```sh
python3 scripts/production/build-offline-bundle.py \
  --release 2026-10-17-rc1 \
  --api tayyn-api:reviewed-commit \
  --web tayyn-web:reviewed-commit \
  --db postgres:17-bookworm \
  --proxy caddy:2.10-alpine \
  --deb-dir /output/packages \
  --monitor-deb-dir /output/packages-monitor \
  --output-dir /output/tayyn-2026-10-17-rc1
```

The exporter rejects non-amd64 images and PostgreSQL majors other than 17. It retags local content IDs under unique release references, exports `images.tar`, and writes `manifest.json`, `release.env` and `SHA256SUMS`. The manifest records content IDs, source commit, dirty-source status, target platform and package filenames. API/web provenance must still be checked against the reviewed build because arbitrary local tags do not establish which source built them. Use a clean checkout for a final release.

The exporter also writes a separate `<output-dir>-monitor` bundle containing only monitoring scripts, examples, documentation and `packages-monitor`. It has its own complete checksums and no application images or Docker packages. Transfer only this small artifact to Standard S, preserving its 10 GB disk for backups. `--monitor-output-dir` can choose another destination.

Only a fixed list of deployment scripts, reviewed configuration examples and documentation is copied. Runtime `.env` files, TLS keys, Firebase credentials, backup identities and SSH keys are excluded. Never add a production secret to an image layer. Output directories cannot be overwritten. Image references are immutable within the manifest; reusing a release name for different content is forbidden.

Checksums detect corruption, not an attacker who replaces both data and checksums. Transfer through verified SSH and compare the SHA256SUMS file hash through a trusted channel. Keep that hash with the release evidence.

## Install on the main VPS

Keep SSH open in two sessions. Confirm the provider's console or another recovery path before changing firewall rules. These scripts do not change UFW, nftables or SSH configuration. Docker published ports can bypass ordinary UFW rules; inspect the actual host/provider rules. Only TCP 80/443 are published by Compose. PostgreSQL and API have no host ports. SSH remains governed by the existing host policy.

Copy a release to `/opt/tayyn/releases/<release>` using SSH/SFTP, then verify and install its offline packages as root.

```sh
cd /opt/tayyn/releases/<release>
sha256sum --check SHA256SUMS
sudo bash scripts/production/install-offline-packages.sh
```

Use the setup wizard from the handoff guide to create `/etc/tayyn/app.env` with mode 0600. Never source this file as shell code. Docker Compose reads it as data. The database password must be generated lowercase hex because it is interpolated into a PostgreSQL URL. CORS includes the production HTTPS origin and native Capacitor origins. The Firebase JSON is one line inside single quotes.

Supply a trusted full certificate chain and matching private key at the wizard's TLS paths. Caddy does not fetch certificates or install packages. Certificate issuance and renewal happen through an approved external process. A replacement certificate must cover DOMAIN and be valid for more than seven days. Replace certificate/key atomically, then recreate only `proxy` so file bind mounts reopen the new files. Monitor expiry and test the entire HTTPS chain from a phone. Namecheap is the DNS provider; its certificate products are optional.

Initialize only an empty production database:

```sh
sudo python3 scripts/production/apply-release.py \
  --bundle /opt/tayyn/releases/<release> \
  --env-file /etc/tayyn/app.env \
  --initialize
```

Initialization refuses any existing public tables before applying migrations. It creates one configured admin and canonical saved regions via `prisma/seed.js`, never drivers/orders/chat fixtures. The fixed project name `tayyn-production` preserves volume identity between releases. Never use `docker compose down -v` on production.

## Apply an update

Retain the current and previous bundles and image IDs. Confirm the new migrations are compatible with existing data and determine whether the previous API can read the resulting schema. Transfer a new immutable release, verify its checksums and package needs, then run:

```sh
sudo python3 /opt/tayyn/releases/<new-release>/scripts/production/apply-release.py \
  --bundle /opt/tayyn/releases/<new-release> \
  --env-file /etc/tayyn/app.env \
  --operations-config /etc/tayyn/operations.json
```

The updater validates files, loaded image identities, runtime configuration, TLS hostname/key/expiry and available Docker disk. It requires at least 6 GiB free or twice the image archive size, whichever is greater. That is a safety floor, not an estimate of future database growth.

Image loading finishes before downtime begins. The updater then stops API/web/proxy writers, takes the configured encrypted backup, runs migrations, and starts the new services with `--pull never`. A failed backup stops the update before migration. It checks database access and public HTTPS liveness before switching `/opt/tayyn/current`. The database backup is taken after writers stop, so the backup reflects the final committed pre-update app state. Expect a short maintenance outage.

The operations configuration must point at the old current release before the update. Its Compose env files include `/etc/tayyn/app.env` and `/opt/tayyn/current/release.env`; it uses only `deploy/production/compose.production.yaml`. Image references in the new release override runtime defaults. Compose never pulls at deployment time. PostgreSQL 17 patch updates are supported; a major upgrade requires a separate tested migration plan.

The updater does not certify Yandex authorization, quota timing, FCM delivery, WebSocket fanout or Android lifecycle behavior. Run the handoff acceptance checks and encrypted restore drill before calling the release ready.

## Recover a failed update

After maintenance starts, a backup or migration/startup failure may leave services stopped. The updater never restores the database automatically, never deletes a volume, and never changes the current symlink before its final checks pass. Save the failure logs locally without posting credentials.

If failure happened before migrations, restart the current release with its original env/image set:

```sh
sudo docker compose --project-name tayyn-production \
  --env-file /etc/tayyn/app.env --env-file /opt/tayyn/current/release.env \
  -f /opt/tayyn/current/deploy/production/compose.production.yaml \
  up -d --pull never --no-deps api web proxy
```

After any migration started, a current symlink still pointing to the old release does not prove the old API is compatible. Inspect migration state and use a forward fix or a previously verified compatible API rollback. Do not blindly restart an incompatible old API. Restoring a database is an explicit incident decision because it discards writes after the backup. First prove the selected encrypted backup restores in a disposable PostgreSQL 17 environment.

If initialization failed after migrations, do not use `--initialize` again against the partly populated database and do not drop it. Inspect the migration/seed failure, complete the bootstrap manually under review, then run the regular path with a verified backup. No script automates destructive bootstrap recovery.

Transfer the separate monitor bundle to Standard S, never the full app/image bundle. The Standard S host uses its `packages-monitor` package set, which excludes Docker. Run `sudo bash scripts/production/install-offline-packages.sh --monitor` there. It installs age/Python/SSH/TLS tools and skips Docker startup. Standard S does not run PostgreSQL or the application. See the operations guide for backup relay, hourly timers, retention, Resend and daily reports.
