# Production setup and updates

The new production origin is `https://taxi.tayynhyzmat.com` on the main VPS, `216.250.8.238`. The monitoring VPS is `216.250.9.242`. Railway remains a test environment. Do not copy its database into production.

This guide separates settings that survive updates from the release files we replace. The first application installation is complete. The domain migration to `taxi.tayynhyzmat.com` is complete; completed checks and remaining gates are recorded in [the handoff](production-handoff.md).

## What we have verified

Both hosts run Ubuntu 24.04.4 amd64. The main host has four CPUs and about 4 GB RAM; monitoring has one CPU and about 1 GB RAM. Public port 22 timed out without packets reaching the main server. Temporary SSH on 443 worked, and tests found port 2222 also works.

Both now have a separate, key-only management service on port 2222. We left their original SSH configuration in place. Each host was rebooted, and a fresh key login succeeded afterward. The provider's web console remains the recovery path.

Shadowrocket's default route timed out to the servers. Binding SSH to the physical `en0` interface worked while Shadowrocket stayed enabled. The owner's ignored SSH configuration records that route, pinned host keys and the dedicated private key:

```sh
ssh -F /Users/bagtyyar/Projects/tayyn-hyzmat-project/.local/vps-bootstrap/ssh-config tayyn-production
ssh -F /Users/bagtyyar/Projects/tayyn-hyzmat-project/.local/vps-bootstrap/ssh-config tayyn-monitor
```

These commands are specific to this Mac. A replacement computer needs its own approved SSH key and host-key verification. Do not send the existing private key through chat or commit it. If its network interface is different, adjust `BindInterface` there.

Git HTTPS to `github.com` also timed out on this connection, while GitHub's API and SSH endpoint on port 443 were reachable. The Mac has a separate repository-scoped write deploy key for release pushes, not installed on either VPS. The private SSH profile defines `tayyn-github` with GitHub host keys obtained through its HTTPS API. Use it when normal Git transport is blocked:

```sh
git -c core.sshCommand="ssh -F /Users/bagtyyar/Projects/tayyn-hyzmat-project/.local/vps-bootstrap/ssh-config" \
  push ssh://git@tayyn-github/bagtyyarkovusov/tayyn-hyzmat-project.git BRANCH
```

GitHub Settings → Deploy keys lists it as `Tayyn operator Mac release access 2026-10-17`. Rotate or remove it there if the operator computer is lost. This key can write only this repository and is separate from production-server and backup keys.

In the Namecheap `tayynhyzmat.com` zone, the A record is host `taxi`, value `216.250.8.238`. Preserve the root-domain website. No AAAA record is needed until IPv6 works. The new A record is verified. The retired hostname used manual DNS-01 after HTTP-01 and TLS-ALPN-01 failed CA secondary validation. The new hostname certificate was issued and installed on 2026-10-18, expires 2027-01-16, and trusted HTTPS/authenticated WebSocket acceptance passed. Unattended renewal is not established.

Gmail SMTP sends from `tkmdevelopers@gmail.com` to `bagtyyarkowusow.dev@gmail.com`. TLS, authentication and an actual setup email were tested from the monitoring VPS. The owner confirmed Inbox receipt. Its Google App Password is stored only in protected configuration. Resend remains an optional transport; it was unreachable from these hosts.

## What stays in place

Keep these outside the immutable release directory:

| Item                       | Location or owner                                    | Update behavior                                                                |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| Database                   | Docker volume `tayyn-production_postgres-data`       | Preserved; migrations change its schema                                        |
| App secrets                | Main `/etc/tayyn/app.env`, mode 0600                 | Reused unless deliberately rotated                                             |
| Monitoring settings        | Monitor `/etc/tayyn/operations.json`                 | Reused; change only when topology or policy changes                            |
| Email credentials          | Monitor `/etc/tayyn/monitor-secrets.json`, mode 0600 | Reused; App Password rotation requires replacing this file                     |
| TLS certificate and key    | Paths in main `app.env`                              | Renew separately; recreate only the proxy after replacement                    |
| Backup encryption identity | Owner's protected offline storage                    | Never place on either VPS                                                      |
| Encrypted backups          | Main and monitor `/var/lib/tayyn/backups`            | Hourly creation and bounded retention                                          |
| Monitor incident state     | Monitor `/var/lib/tayyn/operations`                  | Preserved so restarting cannot resend initialization or reset incident history |
| Operator access            | Each host's management service and authorized key    | Independent of the application containers                                      |

Never run `docker compose down -v` on production. Never overwrite the secrets file with an example during an update.

## Build the release on a connected machine

The manual **Publish container images** workflow has an `offline_bundle` option. Selecting it calls the Ubuntu 24.04 amd64 bundle builder instead of publishing the normal image matrix. This avoids depending on the operator Mac or production VPS for Docker Hub, apt or npm downloads.

The builder checks the production Python tests, downloads signed Ubuntu/Docker package dependency closures, builds the API and web from its checked-out commit, and obtains PostgreSQL 17 and Caddy. It records image IDs, source commit and archive checksums. The browser Maps key comes from the GitHub repository variable `VUE_APP_YANDEX_MAPS_API_KEY`. Runtime keys are excluded.

After reviewed code is merged and its required checks pass, dispatch a build from that exact commit or release tag:

```sh
gh workflow run container-images.yml \
  --repo bagtyyarkovusov/tayyn-hyzmat-project \
  --ref REPLACE_WITH_REVIEWED_COMMIT_OR_TAG \
  -f offline_bundle=true
```

Record the run ID and commit. A green build creates the artifact `offline-production-COMMIT_SHA`, retained for seven days. Download it into a new directory:

```sh
gh run download RUN_ID \
  --repo bagtyyarkovusov/tayyn-hyzmat-project \
  --name offline-production-COMMIT_SHA \
  --dir .local/releases/RUN_ID
bash scripts/production/verify-release-signature.sh .local/releases/RUN_ID
```

This offline check verifies the Sigstore signature over `bundle-archives.sha256` and then the archive checksums. See [the offline guide](offline-production-bundle.md#bundle-signature). Stop if it fails.

The output contains `app-bundle.tar.gz`, `monitor-bundle.tar.gz`, their checksums and `bundle-archives.sha256.sigstore.json`. The app archive contains images and packages; the monitor archive omits Docker and application images. Store the verified artifacts and commit/run evidence securely beyond GitHub's seven-day retention if they are needed for recovery.

## Install or update

Use [the offline installation guide](offline-production-bundle.md) for the exact extraction and package commands. The dependency installer uses local files with downloads disabled. A missing dependency must stop installation; do not work around that by disabling signatures or allowing unexpected online downloads.

Transfer the app archive to the main VPS through the pinned SSH profile. Verify the uploaded archive against the hash checked on the Mac, extract into its new `/opt/tayyn/releases/RELEASE` directory, and verify the bundle's `SHA256SUMS`. Compare `manifest.json` with the expected commit and release before execution. Keep the previous release and do not reuse a release directory for different content.

First installation uses `apply-release.py --initialize` only against an empty database. It seeds one approved admin and canonical saved regions. It must not seed drivers, orders, chat or test balances. A partly initialized database is not empty; investigate a failed bootstrap rather than dropping it or rerunning initialization blindly.

For later updates, run on the main VPS:

```sh
sudo python3 /opt/tayyn/releases/RELEASE/scripts/production/apply-release.py \
  --bundle /opt/tayyn/releases/RELEASE \
  --env-file /etc/tayyn/app.env \
  --operations-config /etc/tayyn/operations.json
```

The updater verifies the manifest, checksums, image identities, configuration, certificate and disk space before maintenance. It loads the images first, stops application writers, takes an encrypted backup, runs migrations, starts the new release, and verifies database access and public HTTPS. It switches `/opt/tayyn/current` only after those checks pass. Expect a short outage during maintenance.

Do not automatically install the monitor archive on every app update. Update its root-owned operations script and service templates when monitoring changes, preserve its secrets and state, then rerun relay and health checks. The selected transport must remain SMTP unless we deliberately change it.

## Authorized one-time rollout 1.20 reset

Use the [scoped reset runbook](production-reset-1.20.md) before the standard updater. It preserves existing admin credentials, every exact saved region, migration/settings/quota records and order-number state. A fresh quiesced encrypted backup, protected off-host copies and owner-local disposable restore are mandatory before deletion. Normal updates never run this reset.

## Verify the result

After each release, confirm the running commit/image IDs, HTTPS and certificate chain, API health and database access. Check an authenticated Socket.IO connection and a real dispatcher/driver workflow. A healthy static page alone is insufficient.

Confirm that the first encrypted backup exists on the main VPS and its verified copy reaches monitoring. Check timers and the external monitor. Initial healthy and daily reports must not say normal while any required check fails. Critical reports use the agreed immediate, 5-minute, 15-minute and then 30-minute cadence; send one recovery report when the incident clears.

Run periodic restores into a disposable PostgreSQL 17 database, using the owner's identity on an isolated restore machine. Never test restore over the live database. An archive checksum does not prove that its contents can be decrypted and restored.

Backend and dashboard updates do not require changing DNS or recreating credentials. The current APK bundles its frontend; rebuilding its screens or changing its configured API endpoint requires a new APK. An in-app update or remote frontend delivery system is separate work, not part of this server updater.

## If an update fails

Keep SSH open and use the failure instructions in [the offline guide](offline-production-bundle.md#recover-a-failed-update). A failed backup stops before migrations. If migrations have begun, do not assume the previous API can read the changed schema. Use a reviewed forward fix or a previously verified compatible image rollback.

The 1.21 [dispatcher cancellation migration](plans/dispatcher-cancellation-1.21-contract.md#forward-only-deployment) is forward-only and has no compatible image rollback: after it runs, 1.20 images cannot accept priced orders or start trips. Recover with a reviewed forward fix, or with a deliberate database restore from the pre-deploy backup together with the 1.20 image. Never roll back the image alone.

Never automatically restore an older database. That could discard trips, balance changes and messages recorded after the backup. Preserve failure evidence without publishing credentials. Use the provider console if management access fails.

## Certificate issuance and renewal

The main VPS reached the production Let's Encrypt directory, but HTTP-01 failed when CA secondary validation could not reach port 80. A direct Mac port-80 probe also timed out. TLS-ALPN-01 through Caddy on port 443 also failed secondary validation. Public connectivity is incomplete across network paths; a successful local probe does not establish CA reachability. Repeating failed requests can consume CA limits.

The selected first-install path is manual DNS-01 with external certificate files. Issuance succeeded after the owner added the TXT record. The active `taxi.tayynhyzmat.com` certificate expires on 2027-01-16. The new runtime configuration selects `TLS_MODE=external`, `TLS_CERT_PATH=/etc/letsencrypt/live/taxi.tayynhyzmat.com/fullchain.pem` and `TLS_KEY_PATH=/etc/letsencrypt/live/taxi.tayynhyzmat.com/privkey.pem`. App operations uses only `compose.production.yaml`. For renewal, the Namecheap TXT Host is `_acme-challenge.taxi` in the `tayynhyzmat.com` zone. Use the new active Certbot value and verify public DNS before continuing; an old value cannot complete a new challenge.

After successful issuance, record the certificate's hostname, expiry and installed paths in the handoff. Keep certificate/key files root-controlled, set the runtime `TLS_CERT_PATH` and `TLS_KEY_PATH`, then recreate the proxy with the installed release configuration. Later certificate replacement must be followed by recreating only `proxy` so file bind mounts reopen the new files. Use the current release's env/image configuration and `--no-deps`; resolve relative bind mounts from its `deploy/production` directory, matching the existing Compose project directory. Do not restart the database or change management SSH on port 2222 for renewal.

Manual DNS-01 needs an operator for each renewal. A generic `certbot renew` timer cannot complete its TXT challenge without an authentication hook. Do not claim unattended renewal or depend on a timer merely being enabled. Keep expiry monitoring and an operator reminder well ahead of expiry until a tested DNS automation method exists.

Caddy automatic TLS remains optional, but its validation failed on these hosts and it is not the selected initial deployment mode. Do not enable a competing automatic issuer or alternate challenge path without checking provider reachability and CA limits. The [DNS renewal review](research/production-dns-certificate-renewal.md) compares Namecheap API automation with delegating only the validation name. No extra DNS service or account credential is configured by this review.

## What makes the next update easier

The same GitHub build and `apply-release.py` command can be reused. SSH, DNS, secrets, persistent volumes and monitoring state remain separate from release files. Record the release directory, commit, artifact run, checksums, migration result, backup name and acceptance checks in the handoff after every deployment.

A later operator command could automate artifact download, checksum comparison, upload and invocation of the existing updater. It should require an exact successful build and preserve these gates. Automatic database restoration, unreviewed deployment on every push, and changing SSH during an app update should remain outside that command.
