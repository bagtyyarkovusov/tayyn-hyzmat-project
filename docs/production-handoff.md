# Production handoff and operations

This is the operational handoff for the first VPS release. Start with the [setup and update runbook](production-update-runbook.md) for the verified access path, persistent settings and later release flow. Exact installation/update commands are in [offline production bundle](offline-production-bundle.md); backup, relay, timer and restore commands are in [production operations](production-operations.md). Read it together with [product scope](product.md), [development environments](development.md), [deployment readiness](deployment-readiness.md), [architecture](architecture.md), [Yandex setup](research/yandex-geocoder-setup.md), and [Firebase setup](research/firebase-notification-setup.md).

## Current status

The first production release is installed on the main VPS from the verified clean-source bundle described below. The Railway services and `apk-test` environments remain test environments; their databases and credentials must not be copied into production. HTTPS health, admin login, authenticated WebSocket access, encrypted backup/relay, monitor checks and a disposable restore have now been verified. Real dispatcher-driver workflow, physical-phone delivery and merge of the deployment PR remain open gates; the clean signed APK has been rebuilt below.

The bootstrap began with one approved admin and the nine versioned saved regions. Current authenticated overview evidence reports two drivers, one active order and four completed trips; these records were not created by this handoff session. Do not seed synthetic drivers, orders, chats, balances, or Railway records into production.

## Target topology

Use two Ubuntu 24.04 LTS amd64 VDS instances:

- **Standard L (main VPS):** HTTPS edge, dashboard, API, PostgreSQL and persistent application data.
- **Standard S (monitoring VDS):** external availability checks, backup pull/retention, disk and backup-age checks, and alert delivery through Gmail SMTP or Resend. It must not run the application database or production API.
- **Dispatcher PC (optional third copy):** pulls an encrypted backup when it is online. The dashboard login is not a backup mechanism; the PC needs a restricted scheduled pull script.

Both VDS instances are with the same provider, so this protects against an application or single-host failure, not a provider-wide outage. The dispatcher PC is an additional independent copy. PostgreSQL remains on a private Docker network; only the intended HTTPS and SSH ports are exposed.

The target runtime path is:

```text
Namecheap DNS -> main VPS :443 -> Caddy/TLS -> nginx web
                                      \\-> API -> PostgreSQL
                                      \\-> Socket.IO on API
main VPS hourly encrypted backup --restricted SSH pull--> monitoring VDS
                                                     \\-> optional dispatcher PC pull
monitoring VDS checks -> Gmail SMTP with verified TLS -> personal Gmail recipient
```

The purchased hosts, agreed domain and installed release are recorded below. DNS, trusted TLS, reboot-persistent management access and the application deployment are verified. Keep private keys, API keys and passwords out of this inventory.

The new production origin is `https://taxi.tayynhyzmat.com`; the owner retired `tayynhyzmat.bagtyyar.dev`. Certificate issuance and the live configuration switch are in progress. Preserve the existing root-domain site. Use a separate monitoring hostname only if the monitor has a web UI that must be exposed. Do not publish PostgreSQL or Docker's control socket.

## Operational inventory

Fill this in during provisioning. An empty field is a deployment gate, not permission to use Railway as production.

| Item                                  | Agreed value / provisioned value                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Main host                             | Standard L, `216.250.8.238`, `tayynhyzmat`; Ubuntu 24.04.4 amd64 verified; key-only SSH port 2222 verified after reboot                  |
| Monitoring host                       | Standard S, `216.250.9.242`, selected and authenticated; Ubuntu 24.04.4 amd64 verified. DC2 test host `216.250.13.190` remains untouched |
| DNS owner                             | Namecheap; `bagtyyar.dev`                                                                                                                |
| Production HTTPS origin               | `https://tayynhyzmat.bagtyyar.dev`; DNS, trusted TLS and health/login checks verified; certificate expires 2027-01-15                         |
| Monitoring HTTPS origin               | Pending, or private access only                                                                                                          |
| Alert recipient                       | `bagtyyarkowusow.dev@gmail.com`                                                                                                          |
| Resend verified sender                | Production sender domain pending; `onboarding@resend.dev` permitted for initial tests to the confirmed Resend account email only         |
| Current/previous production release   | `/opt/tayyn/current` → `vps-2-68c2f354c4374fdcaed850a6af6378f8af63ab4a`; bundle run `39037794659`                                      |
| Main runtime configuration            | `/etc/tayyn/app.env`                                                                                                                     |
| Monitor runtime configuration         | `/etc/tayyn/operations.json` and `/etc/tayyn/monitor-secrets.json`                                                                       |
| Backup storage and private key holder | Hourly encrypted archive on main + verified relay on monitor; private age identity remains on the owner Mac                                 |
| Last restore test and alert test      | 2026-10-18 UTC disposable PG17 restore + tamper rejection; monitor initialization email sent and healthy check verified                 |

### Purchased-host checks, 2026-10-17

Read-only SSH checks succeeded on the main VPS at 12:31 UTC through a temporary SSH listener on TCP 443. The ED25519 host fingerprint was independently compared with the provider-console output before password authentication. Private credentials and raw reports stay in ignored, owner-only `.local/vps-bootstrap/`; they are not deployment configuration.

- Main host: four logical CPUs, 3,915 MiB RAM, no swap, 60 GiB virtual disk and about 56 GiB free on `/`. This is an inventory check, not a workload benchmark. Passwordless sudo works and NTP reports synchronized.
- Docker and `age` are absent. Python, curl, OpenSSL, rsync, tar, gzip and zstd are present. No packages, containers, production accounts or application configuration were installed during these checks.
- External TCP 22 timed out from the Mac through a mobile hotspot with Shadowrocket disconnected. A coordinated 60-second VPS capture recorded zero port-22 packets. SSH itself listens on IPv4/IPv6; UFW is inactive and nftables, iptables and ip6tables exports are empty. SSH on TCP 443 returned a valid banner and authenticated successfully. This isolates a port-specific network restriction but does not identify its operator. Resolve permanent SSH access before assigning 443 to HTTPS. The temporary listener is not a production management configuration and expires automatically.
- From the main VPS, TCP 22 on itself and `216.250.9.242` returned SSH banners. The DC2 test host `216.250.13.190` returned `No route to host`. At this point no monitoring host had been authenticated or deleted; subsequent provisioning is recorded below.
- Verified DNS/TLS handshakes to Yandex geocoder and Maps, Google OAuth, FCM, GHCR and Let's Encrypt. This proves network/TLS access only, not keys, quota, image pulls, certificate issuance or notification delivery. No geocoder requests or emails were sent.
- `api.resend.com` resolves, but both returned IPv4 addresses refused TCP 443; IPv6 is not routed on this host. Email is a deployment blocker until access is verified from the selected monitoring server. Do not claim delivery or work around certificate validation.
- At 12:34 UTC, Gmail SMTP on ports 465 and 587 passed verified TLS 1.3 and returned EHLO 250 from the main VPS; Gmail API port 443 also passed TLS. No authentication or email send was attempted. Gmail SMTP is a viable candidate, pending monitoring-host tests, a Google App Password and an SMTP implementation. Subsequent SMTP implementation and host tests are recorded below; these initial probes did not establish email delivery.
- `tayynhyzmat.bagtyyar.dev` did not resolve from the VPS. Create the Namecheap `A` record for host `tayynhyzmat` pointing to `216.250.8.238`, then verify DNS, trusted TLS and renewal.

### Management and SMTP provisioning, 2026-10-17

The production domain was changed by the owner to `tayynhyzmat.bagtyyar.dev`, and it now resolves to `216.250.8.238`. Certificate issuance is still pending.

Both main and original monitoring VPSs now run `tayyn-management-ssh.service` on TCP 2222 with public-key-only authentication, root login disabled and only the `ubuntu` operator allowed. The dedicated operator key is private on the owner's Mac. Existing port-22 SSH configuration was preserved. Both servers were rebooted individually; changed boot IDs and successful fresh key logins verified that management access survives reboot. Do not stop this service or replace keys before a second verified session and provider-console recovery are available. The service template is in `deploy/monitoring/tayyn-management-ssh.service`; install the operator public key before enabling it.

With Shadowrocket enabled on the Mac, the default VPN route timed out to the hosts while `BindInterface en0` reached them. The ignored owner-only SSH configuration at `.local/vps-bootstrap/ssh-config` defines `tayyn-production` and `tayyn-monitor`, using pinned host keys and port 2222. Operator commands on this Mac are:

```sh
ssh -F /Users/bagtyyar/Projects/tayyn-hyzmat-project/.local/vps-bootstrap/ssh-config tayyn-production
ssh -F /Users/bagtyyar/Projects/tayyn-hyzmat-project/.local/vps-bootstrap/ssh-config tayyn-monitor
```

The original Standard S is verified as Ubuntu 24.04.4 amd64, one logical CPU, 961 MiB RAM and about 7 GiB free. It is selected for provisioning; the DC2 test VPS is untouched. Gmail SMTP on port 465 passed TLS and authenticated successfully from Standard S. The sender is `tkmdevelopers@gmail.com`; the alert recipient is `bagtyyarkowusow.dev@gmail.com`. The App Password is only in protected local/runtime files. The selected transport is now SMTP, not Resend. The setup email was accepted by Gmail and the owner confirmed Inbox receipt, not Spam. Scheduled monitoring and incident/recovery acceptance remain pending.

Local Docker Hub downloads failed on the operator Mac. `.github/workflows/offline-production-bundle.yml` provides a manual connected Ubuntu 24.04 amd64 builder. It downloads signed package dependency closures, builds images from its checked-out commit with the public Maps key, and exports checksummed app and monitor archives. Artifacts contain no runtime credentials and expire after seven days. Package installation with downloads disabled and application startup/reboot still need verification on the purchased hosts. The app package closure includes Certbot for domain-certificate issuance and renewal.

### Firebase production credential, 2026-10-17

The owner supplied a separate Firebase Admin SDK private key for the existing `tayyn-hyzmat` project. Its project/type were validated and it was stored in ignored owner-only configuration, then installed only in main `/etc/tayyn/app.env`. The new production package is `tayyn.hyzmat.production` in that same project; the test package remains `io.openride.driver.test`. The first production APK is a separate installation and does not inherit the test APK session or permissions. Later production APKs must retain this package and signing key. Production authenticated with Google OAuth and received HTTP 200 for an FCM `validate_only` request. That sent no notification and does not establish delivery to a physical phone. Keep the private key out of Git, images, logs and the monitoring VPS. Rotate its individual key separately from test-backend credentials.

### Offline simulation and provenance, 2026-10-17

GitHub run `39035095601` built Ubuntu amd64 app and monitor archives from `3ce2e8f3abd13ea7824c2102d8c7158b35b1b03e`. The downloaded artifact matched GitHub SHA-256 `66562f24037ae043f260b2e80617d98aa36c2af4ad1147eca0f5754d495ee964`; both archive hashes and transferred monitor internals passed. Its manifest reports `sourceDirty: true`, so it is not the final application candidate. Python cache exclusions and a prebuild clean-source check were added for the replacement build.

The initial target-side apt simulation failed on a systemd dependency conflict before making package changes. Installing every dependency file explicitly can force unnecessary OS upgrades. The corrected installer selects missing tools from a local-only repository and rejects changes to installed packages. Its target-specific simulations passed on both Ubuntu hosts, then offline installation succeeded. Docker 29.9.1, Compose 5.6.0, Certbot 2.9.0 and age were installed on main; only age was needed on monitor. Fresh SSH sessions succeeded afterward, and both hosts retained OpenSSH client/server version `1:9.6p1-3ubuntu13.16`. Main/monitor management access remains available. The dedicated monitor backup key successfully executed the restricted `list` command on main; the empty result is expected before the first backup.

### Certificate validation attempts, 2026-10-17

The main host reached Let's Encrypt's production ACME directory, but HTTP-01 issuance failed when a CA secondary validator could not connect to port 80. The direct Mac port-80 probe also timed out. Caddy TLS-ALPN-01 was then tested on port 443 and also failed CA secondary validation. Reaching the VPS from one network does not establish reachability from every CA validation location. These results are consistent with partial network restrictions; they do not prove which operator applies them.

Manual DNS-01 through Namecheap succeeded after the owner published the active TXT challenge. Let's Encrypt issued the certificate for `tayynhyzmat.bagtyyar.dev`, expiring 2027-01-15. Its paths on main are `/etc/letsencrypt/live/tayynhyzmat.bagtyyar.dev/fullchain.pem` and `/etc/letsencrypt/live/tayynhyzmat.bagtyyar.dev/privkey.pem`. Main runtime configuration now selects `TLS_MODE=external` and those paths. App operations uses only `deploy/production/compose.production.yaml`. Certificate issuance is verified; the application deployment's trusted public HTTPS and other acceptance checks remain separate gates.

Automatic Caddy mode remains an optional feature, not the working deployment mode on these hosts. It has not established unattended issuance or renewal here. Manual DNS-01 also does not provide unattended renewal. The operator must renew through DNS validation, install the new certificate/key and recreate only the proxy before expiry. See the [renewal options](research/production-dns-certificate-renewal.md) and [update runbook](production-update-runbook.md#certificate-issuance-and-renewal) before choosing automation.

The owner backup identity was generated on the Mac using the official age v1.3.2 Darwin arm64 asset after matching its published SHA-256. Only the public recipient is in app operations configuration. Keep an additional protected offline copy of the private identity; neither VPS receives it.

### Lookup cutover and SSH hardening, 2026-10-17

The isolated Railway `apk-test` API used the same Yandex HTTP Geocoder credential as the production candidate. To prevent two independent database budgets spending the same vendor allowance, only its `YANDEX_GEOCODER_DAILY_LIMIT` was changed to `0`; the key, timezone, reset hour and Referer were preserved. Deployment `92097293-fd5a-4629-a2fd-aea25c90bf16` reached `SUCCESS`, and an SSH readback from that exact deployment confirmed runtime limit `0`. Shared development was left unchanged and has no enabled geocoder configuration.

A read-only transaction at 13:50:04 UTC found the test budget at period `2026-10-17`, with four attempts, zero failures and no active breaker. One additional direct request from main, outside that counter, returned HTTP 200 with an address for a synthetic Ashgabat point. The temporary remote credential candidate and checker were removed and their absence verified. This establishes provider acceptance for that request; it does not measure the vendor account's complete usage.

Production is configured with an allocation of `1000`, an application ceiling of `800`, timezone `Europe/Moscow`, reset hour `0` and caching disabled. Application deployment and production counter initialization remain pending at this checkpoint. The initial production budget will conservatively carry **25 attempts** for `2026-10-17`, covering the four persisted test attempts, the known direct request and additional allowance for manual checks. Preserve any usage already recorded in production when applying the carryover. The next quota day begins at 00:00 Moscow, 21:00 UTC. GPS, regions and driver work remain independent of address availability. No production drivers or orders exist at this checkpoint.

The pending application deployment uses the clean-source bundle built from `68c2f35`. This evidence-only documentation update does not require rebuilding its images or altering the verified bundle. Append the applied release identifier, initialized counter and acceptance results after deployment.

Both hosts now have `/etc/ssh/sshd_config.d/00-tayyn-key-only.conf` disabling password authentication and root login for the global SSH service, including the port-22 listener. This follows the earlier step that initially preserved its configuration. Management on port `2222` remains key-only. Fresh operator-key login verification after this hardening is underway; retain the existing session and provider-console recovery until it succeeds on both hosts.

### First production release and operations evidence, 2026-10-18

The clean-source application bundle from commit `68c2f35` and GitHub artifact run `39037794659` is installed as release `vps-2-68c2f354c4374fdcaed850a6af6378f8af63ab4a`. The bundle and internal `SHA256SUMS` matched the trusted manifest; `apply-release.py --initialize` applied 25 migrations and bootstrapped one admin plus nine canonical regions. The main host reports healthy `db`, `api`, `web` and `proxy` containers. Pinned HTTPS checks returned 200 for `/health`, `/`, `/api/health` and admin login.

The main `tayyn-backup.timer`, monitor `tayyn-backup-relay.timer` and monitor `tayyn-monitor.timer` are enabled and active. The first archive was created on 2026-10-18 at 12:08 UTC, encrypted with the owner age recipient, pulled to the monitor with matching size and SHA-256, and retained on both hosts. The monitor then reported all checks healthy and sent its one-time initialization email; the next run sent no duplicate.

The relayed archive was copied to the owner Mac and its SHA-256 was checked against the monitor. Using the private owner identity only on the Mac, it restored into a disposable PostgreSQL 17 container and database. The restored snapshot contained one admin, nine districts, two drivers, six orders, three users and 25 migrations. A one-byte tampered copy was rejected before creating its disposable database. The restore container was removed afterward; production was never replaced.

A pinned acceptance probe completed admin login, overview read and an authenticated WebSocket connection. The original helper's unpinned hostname request was blocked by the current Mac gateway, while the same checks passed with the documented pinned origin probe. A real dispatcher-driver workflow and FCM delivery on the target Infinix remain pending; no driver or order was seeded for this check. The Yandex carryover was skipped because the Moscow quota day had already rolled over.

A clean signed production APK was rebuilt from source commit `3b055c31` with the verified production endpoints. It is `TayynHyzmat-production-1.18-code19.apk`, application ID `tayyn.hyzmat.production`, version 1.18/code 19, SHA-256 `462d4bd67391122fdb29a624741ba7aa881f061e234b2fbff3ca7945f5426caa`, and signing certificate SHA-256 `a675842c5d0c2bfb62b08c02aff99687b66c8580180591a4ebf8169716d240b6`. Physical Android 14 lock-screen, Doze, force-stop, GPS, Yandex and splash checks remain open.

## Namecheap DNS and TLS

At Namecheap, in the `tayynhyzmat.com` zone, use an `A` record with Host `taxi`, value `216.250.8.238` and Automatic TTL. Manual certificate validation uses a TXT record with Host `_acme-challenge.taxi` in that same zone and the active Certbot challenge value. Add an `AAAA` record only after IPv6 is configured and tested; a broken AAAA record can make some phones fail before IPv4 is tried. Point a separate monitoring hostname to Standard S only if needed. Keep DNS TTL low during cutover, then raise it after verification.

The selected external-certificate Caddy configuration terminates TLS and proxies `/` to nginx web, while `/api`, `/health` and `/socket.io` go directly to the API. This keeps one trusted proxy before Express. Place the publicly trusted certificate and matching private key at `TLS_CERT_PATH` and `TLS_KEY_PATH` on the main VPS with restricted permissions. Verify port 443, the trusted chain, WebSocket upgrade, CORS origin and mobile network access before calling deployment ready. Check the port-80 redirect separately; the present network restriction means it cannot be promised to all clients. DNS-01 avoids inbound CA validation but still requires reachable ACME services and authoritative DNS. Keep an existing management SSH session and provider-console recovery while changing networking.

## Credential boundaries

Secrets are runtime inputs, never image layers, committed files, readiness output, or chat messages.

| Location                                         | Holds                                                                                                                                                                                                                                                 | Notes                                                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main VPS `/etc/tayyn/app.env`, owner-only        | `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `DOMAIN` and production/native `CORS_ORIGIN`, seed values used only during bootstrap, server-side Yandex geocoder key/referer, Firebase service account data                          | Use a regular `0600` file outside the repository. Do not use the test `.local` files. The standalone production Compose file passes geocoder/FCM variables at runtime. |
| Web image build configuration                    | `VITE_YANDEX_MAPS_API_KEY` / legacy `VUE_APP_YANDEX_MAPS_API_KEY`                                                                                                                                                                                     | This is a browser-visible key. Restrict it to the actual production origins and rebuild the web/APK when it changes. Never place server credentials in it.             |
| Monitoring VDS `/etc/tayyn/monitor-secrets.json` | Selected Gmail SMTP sender, Google App Password and `bagtyyarkowusow.dev@gmail.com` recipient. Optional Resend credentials only when that transport is selected. Operational paths and restricted SSH settings belong in `/etc/tayyn/operations.json` | Email credentials belong only here. Use the approved Google App Password, never the normal Google account password.                                                    |
| Backup key storage                               | Public encryption key on the backup producer; private decryption key held separately by the operator/dispatcher PC                                                                                                                                    | A compromised VPS must not be able to decrypt its own off-server copies.                                                                                               |

The selected sender is `tkmdevelopers@gmail.com`, authenticated through Gmail SMTP on TLS port 465, and the recipient is `bagtyyarkowusow.dev@gmail.com`. The owner confirmed the test message arrived in Inbox. This requires no app-domain mail records. Resend remains optional and needs its own verified sender DNS if selected later; it is currently unreachable from the VPSs.

Yandex browser Maps access and server reverse-geocoding access are separate. The backend key must be tested with the production server's actual outbound identity and any required referer. A successful DNS/TLS probe is not proof of a valid key, quota, address result, or phone delivery. FCM credentials authenticate the backend sender; driver networks still need to reach Google's FCM endpoints.

## Offline Ubuntu bundle

The provider firewall may block package repositories and image registries. Prepare and test a transfer bundle on a matching Ubuntu 24.04 amd64 machine before touching the VPS. The bundle should contain:

- pinned Docker Engine and Compose `.deb` packages plus dependency packages;
- versioned API, web, PostgreSQL and HTTPS-edge images exported as Docker-loadable archives;
- image digests, package checksums and a manifest containing the release commit/tag;
- production Compose files and non-secret configuration templates;
- install, preflight, backup, update, health-check and rollback scripts;
- a minimal offline restore utility and documentation.

The production stack is separate from the developer `compose.yaml`: use `deploy/production/compose.production.yaml` and `deploy/production/Caddyfile`. Prepare the archive with `scripts/production/build-offline-bundle.py`; apply it with `scripts/production/apply-release.py`. Do not tell an operator that the bundle is ready until it has been tested with outbound registry and apt access disabled. Supplying `.deb` files is not proof of dependency closure; prove installation on a fresh matching Ubuntu 24.04 amd64 system. The GHCR workflow builds multi-architecture images and uses the repository variable `VUE_APP_YANDEX_MAPS_API_KEY` for the browser key. Verify that the release uses the production-restricted browser key; the backend key still belongs only in runtime configuration.

The installation script must:

1. verify Ubuntu release, `amd64` architecture, disk, memory, CPU, available ports and checksums;
2. install only the supplied packages and load only the supplied images;
3. create protected runtime files without printing values;
4. configure Docker log rotation and restart policies;
5. create the persistent PostgreSQL volume and run migrations;
6. bootstrap exactly one admin and the canonical saved regions in a fresh database;
7. start the stack and run health, WebSocket and TLS checks;
8. run the first backup and monitor checks, then confirm the initialization email reaches Gmail. This reports monitored health; physical-phone delivery and restore checks remain separate release gates.

A failed preflight must stop before changing production. The updater checks selected host/configuration requirements; run the readiness diagnostic and manual port/SSH checks too rather than treating the updater as a complete host audit. Setup must preserve the existing SSH path and provide a recovery-console procedure.

Run the configuration wizard on the operator workstation:

```sh
bash scripts/production/setup-wizard.sh
```

It writes private `.local/production/production.env` and `monitor-secrets.json` files. Transfer the former only to Standard L as `/etc/tayyn/app.env`, and the latter only to Standard S as `/etc/tayyn/monitor-secrets.json`, both mode `0600`. It guides Namecheap/Resend DNS, TLS paths, Yandex quota setup and Firebase service-account selection. It does not install or deploy. Run it without `bash -x`; tracing would expose secrets. Keep the generated files for future updates rather than regenerating passwords.

## Updates and rollback

Future agents must work on a feature branch, read this guide and the linked scope/development documents, run the required checks, and record the release tag and image digests. Do not edit or seed shared Railway while preparing a production release. `main` deploys shared Railway; that is not a production VPS deployment.

The release flow is:

1. Implement on a feature branch with focused tests and documentation.
2. Run typecheck, formatting, unit/integration/browser checks and the relevant Docker build/startup checks.
3. Review the diff and update this handoff when the operational behavior changes.
4. Create a version tag and publish immutable API/web images (or export the tested images for offline transfer).
5. Transfer the checksummed bundle over SSH, verify it against the trusted release manifest on the VPS, and load/verify images before maintenance. The updater then stops app writers and takes an encrypted backup before migrations. Expect a short outage; read the failed-update recovery commands before starting.
6. Apply `prisma migrate deploy` before starting the new API. Migrations must be forward-compatible with the currently running version.
7. Start the new image, check HTTPS, `/health`, Socket.IO, database access and the real APK configuration.
8. Record the deployment result and verify the monitor returns to healthy. The current monitor sends initialization, daily, incident and recovery emails; a separate email for every new release is not yet implemented.

Rollback means switching API/web images back to the last known-good release and verifying health. Never automatically restore an older database or reverse a migration: that could discard orders, balances, messages or trip history. A migration rollback needs a separately reviewed forward migration and a tested backup restore in a disposable database.

## Backups and restore

The main VPS should create an encrypted PostgreSQL backup every hour. The monitoring VDS pulls the newest completed file over a dedicated SSH key restricted to backup download (no shell, no write, no port forwarding). Keep, subject to a restore test and disk measurement:

- the newest 24 completed archives, normally created hourly; extra manual/update backups consume positions in this set;
- the newest archive on each of the last 14 UTC dates;
- automatic deletion of older copies;
- warning at 70% disk use and critical alert at 85%.

The Standard S has only 10 GB, so retention must be enforced and backup sizes monitored. Transfer only the exporter's separate `<output-dir>-monitor` artifact to Standard S. It has its own checksums and `packages-monitor`, without application images or Docker packages. Run the package installer with `--monitor`; do not copy the full main-VPS image bundle there. The dispatcher PC may pull a third copy when it is online; if it is offline, the VPS and Standard S continue using their own retention. The monitor treats a backup copy or relay older than two hours as a critical failure. Verify hourly completion separately during cutover. Keep the last successful restore-test date in the operational inventory; the current monitor does not automate restore drills.

Test a restore on an isolated restore host into a disposable PostgreSQL container before cutover and periodically afterward. Point its operations configuration only at that disposable stack. Never put the private backup identity on either VPS or run restore against the production Compose project. Keep the private decryption key separately from both VPS instances. A same-host Docker volume, provider snapshot or untested archive is not an independent recovery plan.

## Monitoring and email policy

The monitoring VDS must run lightweight checks, not an unrestricted log warehouse:

- HTTPS dashboard and API health;
- Socket.IO Engine.IO polling handshake, including its advertised WebSocket upgrade; a real authenticated WebSocket upgrade remains a release test;
- database read-only health through an application endpoint or controlled check;
- Docker/container state and restart count on the main VPS;
- disk space on both VDS instances;
- newest backup age, size and checksum;
- certificate expiry;
- outbound Yandex, Google/FCM and the selected email transport connectivity where applicable.

Restart policies recover an exited process or a reboot. They do not prove that a hung process is healthy. The current tooling alerts on unhealthy services and restart changes. It does not automatically restart a merely unhealthy container; an operator must investigate and use a bounded recovery action. Add automated hang recovery only with a retry limit and a test that prevents restart loops. Alerts must not include customer phones, driver data, tokens or database contents.

Email cadence, sent via the configured SMTP or Resend transport to `bagtyyarkowusow.dev@gmail.com`:

- **Critical failure:** send immediately, then at 5 and 15 minutes, then every 30 minutes while the condition remains unresolved. Group duplicate failures into the same incident. Send one recovery email when the condition clears.
- **Noncritical warning:** include it in the daily attention report; it must suppress a normal report. Critical conditions use the incident cadence above.
- **Daily report:** send at 09:00 Asia/Ashgabat. Say “normal” only when all monitored checks pass, including API/dashboard, database, backup freshness and copy, disk space, container state/restarts, certificate and configured provider connectivity. Application exception aggregation and real phone delivery remain separate checks. Otherwise send a failure report with the failed checks.
- **Initial launch:** the monitor sends once after its health, TLS, backup and connectivity checks pass. A container restart or page refresh must not resend it. Keep the initialization marker in the monitor's persistent state directory, outside transient container state.

An external monitor cannot report a complete provider-wide outage if it is hosted by the same provider. Keep the dispatcher PC copy and recovery-console access as additional safeguards.

## Readiness commands and evidence

On the VPS, after the bundle is installed and before production traffic:

```sh
python3 scripts/production-readiness.py \
  --config-file /etc/tayyn/app.env \
  --project-name tayyn-production \
  --compose-file deploy/production/compose.production.yaml \
  --network --offline --email-transport smtp \
  --api-url https://taxi.tayynhyzmat.com/api \
  --web-url https://taxi.tayynhyzmat.com \
  --json > readiness-report.json
```

The script is read-only: it does not install packages, source secrets, restart containers, seed data, call the paid geocoder, validate a Yandex key, send FCM, or send email. With `--network --offline --email-transport smtp` it checks Yandex/Google TLS and SMTP TLS/EHLO from the machine running the script, omitting unused GHCR and Resend; it does not prove that the remote VPS or driver phones can reach those providers. A separate bounded email send test must prove provider acceptance without exposing credentials; it still cannot guarantee arrival in the Gmail inbox until the operator confirms receipt.

A successful script result is evidence, not a production certificate. The report must be accompanied by:

- matching Ubuntu/amd64 and offline-bundle checksum evidence;
- verified Namecheap DNS and TLS/WebSocket checks;
- clean database bootstrap evidence (one admin, canonical regions, no test records);
- Yandex address result and quota/restriction check;
- Firebase delivery from the production-configured APK on a physical phone;
- first backup and disposable restore evidence;
- monitoring alert and recovery-email test;
- workload benchmark using disposable synthetic data, never shared Railway or production records.

Railway simulation is useful for application behavior and provider reachability from Railway, but it does not establish VPS performance, firewall behavior, disk durability, or physical-phone delivery. See [deployment readiness](deployment-readiness.md) for the measured limitations.

## Handoff checklist for the next agent

Before changing production-related files:

- Read `AGENTS.md`, `docs/product.md`, `docs/coding-standards.md`, `docs/development.md`, this file, and the relevant Yandex/Firebase docs.
- Confirm the target environment and whether the work is test-only, bundle preparation, or an authorized production cutover.
- Keep secrets in protected runtime files; never print or commit them.
- Use isolated synthetic data and disposable databases. Never point tests at shared Railway or production.
- Preserve Docker startup, migration ordering, persistent volumes, SSH access and the rollback path.
- Update this guide and `docs/deployment-readiness.md` when commands, ports, credentials, retention or release gates change.
- Record release tag, image digests, migration status, backup/restore evidence, alert test and known limitations.
- Do not claim “production ready” while any gate above remains unverified.
