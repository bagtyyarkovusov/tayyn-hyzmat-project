# Production backups and independent monitoring

The application belongs on the Ubuntu 24.04 amd64 Standard L VPS. The Standard S VPS pulls encrypted backups and probes the application from a different machine. Railway remains testing/staging. Both servers have been purchased and their OS, resources and reboot-persistent SSH access verified; application deployment and backup/alert acceptance remain pending. See [production handoff](production-handoff.md) for domain, deployment and owner records; fill the actual addresses before installation.

The tooling is `scripts/production/operations.py`. It uses Python's standard library, Docker Compose on the app host, OpenSSH and the `age` executable. The offline bundle must include Ubuntu packages for Python 3, CA certificates, timezone data, OpenSSH client, age, Docker and Compose plus their dependency closure. The VPS provider must already supply a working OpenSSH server; the package does not replace or reconfigure the existing SSH service. Install package artifacts from the verified bundle, not an internet package repository on the restricted VPS.

## Configuration and credentials

Copy the appropriate template from `deploy/monitoring/` to `/etc/tayyn/operations.json`. It must have mode 0600. App configuration is root-owned. Monitor configuration, email secrets and the outbound SSH private key are owned by the `tayyn-monitor` service user, all mode 0600. `/etc/tayyn/known_hosts` must contain the app server's fingerprint verified through the VPS console or another independent channel. Do not disable host-key checks or trust an unverified `ssh-keyscan` result.

The app template uses `/opt/tayyn/current`, the `tayyn-production` Compose project, `/etc/tayyn/app.env` for secrets and `/opt/tayyn/current/release.env` for image references. Confirm these match the installed bundle. The templates are examples, not working credentials.

The selected transport is Gmail SMTP. Use `deploy/monitoring/monitor-secrets.smtp.example.json`, with `email_transport: smtp`, `smtp_host: smtp.gmail.com`, `smtp_port: 465`, sending account `tkmdevelopers@gmail.com`, its Google App Password, and `alert_email: bagtyyarkowusow.dev@gmail.com`. Enable Google two-step verification first. Keep the App Password separate from the normal Google password. Port 465 uses verified TLS; port 587 uses mandatory STARTTLS. Unencrypted SMTP is rejected. No sender-domain DNS verification is required for Gmail SMTP.

Resend remains supported through the original template with `email_transport: resend` or no transport field for backward compatibility. Its fields are `resend_api_key`, `resend_from` and `alert_email`. Use a sender from a domain verified in Resend; its exact TXT/MX records are independent of the app's production A record. Preserve existing mail records.

Notification state advances only after the transport accepts the message. SMTP does not provide Resend's idempotency API: an ambiguous disconnect after acceptance can cause a duplicate retry. A stable Message-ID identifies the event but cannot guarantee recipient deduplication. Verify actual inbox delivery and incident/recovery cadence before launch.

## Encryption ownership

Generate the restore identity on the owner's secure computer, not either VPS:

```sh
umask 077
age-keygen -o tayyn-owner.agekey
age-keygen -y tayyn-owner.agekey
```

Put only the printed `age1...` public recipient in the app's `age_recipient` setting. Store the identity and an additional protected copy offline. Losing the private identity makes every encrypted backup unrecoverable. Compromise of either VPS must not disclose that identity.

Backups stream `pg_dump -Fc` directly into age's authenticated encryption. No plaintext backup file is written on the app or monitor VPS. A failed dump or encryption removes its partial file and never publishes a finished archive. Completed archives have unique UTC names and mode 0600. The archive includes the PostgreSQL database; uploaded files, production secrets, Firebase credentials, TLS data and the owner identity are separate assets. Keep protected offline copies of configuration and credentials too.

## App-host setup

The workstation setup wizard generates private configuration files; it does not install files on a VPS. Transfer those files over verified SSH, then install the correct role configuration and root-owned script. Run the following from the extracted bundle on the app VPS with a root session. Replace the configuration source path with your securely transferred app configuration. It must contain the real public age recipient.

```sh
install -d -m 755 /opt/tayyn
install -d -m 700 /etc/tayyn /var/lib/tayyn/backups /var/lib/tayyn/operations
install -m 755 scripts/production/operations.py /opt/tayyn/operations.py
install -m 600 /secure/transferred/app-operations.json /etc/tayyn/operations.json
install -m 644 deploy/monitoring/tayyn-backup.service /etc/systemd/system/
install -m 644 deploy/monitoring/tayyn-backup.timer /etc/systemd/system/
python3 /opt/tayyn/operations.py --config /etc/tayyn/operations.json backup
systemctl daemon-reload
systemctl enable --now tayyn-backup.timer
systemctl list-timers tayyn-backup.timer
journalctl -u tayyn-backup.service --since today
```

The timer runs hourly, with at most 30 seconds jitter and a catch-up run after downtime. The installer should run the first backup immediately. The update procedure must require a successful backup before replacing application containers. Backup runs do not stop the application and PostgreSQL supplies a consistent snapshot. Stopping writers for an update belongs to the update script.

Retention keeps the newest 24 archives plus the newest archive on each of the last 14 UTC dates. With normal hourly scheduling this gives hourly recovery points for roughly a day and daily points for two weeks. Extra manual backups consume positions in the newest-24 set. Retention runs only after a completed backup or successful relay. It is not a promise that 10 GB is sufficient forever. Measure archive growth and adjust retention or storage before the monitor disk reaches 70%.

Create an app-host `tayyn-backup` SSH user with password login disabled, a usable `/bin/sh` shell for the forced command, and no Docker-group membership. The monitor gets one dedicated SSH key. Install `deploy/monitoring/authorized_keys.example` as that account's only key after replacing its public key and source IP. Keep the file and parent directory root-controlled so the account cannot replace its forced command. The key has no interactive shell, forwarding or unrestricted command rights.

Install `deploy/monitoring/tayyn-backup.sudoers.example` as `/etc/sudoers.d/tayyn-backup`, root-owned mode 0440, and validate it with `visudo -cf`. Its only root command is:

```sh
/usr/bin/python3 /opt/tayyn/operations.py --config /etc/tayyn/operations.json serve
```

The forced command accepts only `facts`, `list` or `fetch <strict archive filename>` through `SSH_ORIGINAL_COMMAND`. It never evaluates shell input. The config and Python file must remain root-owned and unwritable by that account. Restrict SSH at the firewall to the operator and monitor addresses without closing the current operator connection. Verify another SSH session before changing existing access rules.

## Monitor-host setup

Create the unprivileged `tayyn-monitor` user. It needs no Docker daemon and no application secrets. The role-specific configuration uses the production domain and dedicated app backup SSH target. Run these commands from the extracted bundle on the monitor VPS as root, replacing securely transferred file paths. Keep `/opt/tayyn/operations.py` root-owned. Enable only the relay and monitor units on this host:

```sh
id tayyn-monitor >/dev/null 2>&1 || useradd --system --home-dir /var/lib/tayyn --shell /usr/sbin/nologin tayyn-monitor
install -d -m 755 /opt/tayyn
install -d -m 700 -o tayyn-monitor -g tayyn-monitor /etc/tayyn /var/lib/tayyn/backups /var/lib/tayyn/operations
install -m 755 scripts/production/operations.py /opt/tayyn/operations.py
install -m 600 -o tayyn-monitor -g tayyn-monitor /secure/transferred/monitor-operations.json /etc/tayyn/operations.json
install -m 600 -o tayyn-monitor -g tayyn-monitor /secure/transferred/monitor-secrets.json /etc/tayyn/monitor-secrets.json
install -m 600 -o tayyn-monitor -g tayyn-monitor /secure/transferred/app-backup-key /etc/tayyn/app-backup-key
install -m 600 -o tayyn-monitor -g tayyn-monitor /secure/transferred/verified-known-hosts /etc/tayyn/known_hosts
install -m 644 deploy/monitoring/tayyn-backup-relay.service /etc/systemd/system/
install -m 644 deploy/monitoring/tayyn-backup-relay.timer /etc/systemd/system/
install -m 644 deploy/monitoring/tayyn-monitor.service /etc/systemd/system/
install -m 644 deploy/monitoring/tayyn-monitor.timer /etc/systemd/system/
sudo -u tayyn-monitor python3 /opt/tayyn/operations.py --config /etc/tayyn/operations.json relay
sudo -u tayyn-monitor python3 /opt/tayyn/operations.py --config /etc/tayyn/operations.json monitor
systemctl daemon-reload
systemctl enable --now tayyn-backup-relay.timer tayyn-monitor.timer
systemctl list-timers 'tayyn-*'
```

`monitor` sends real email when configured. Run it only when the recipient and sender are approved. No real emails are sent by the repository's automated tests.

The relay checks every five minutes. It pulls encrypted archives over pinned SSH, streams each copy to a partial file, verifies its size and SHA-256 against the app inventory and publishes it atomically. Corrupt copies never replace a verified archive. Encryption authentication is checked again during a restore drill. The monitor has only ciphertext and cannot decrypt it. A dispatcher-PC copy is an optional third copy, not the scheduled backup destination.

The monitor checks once per minute:

- Public HTTPS dashboard response, API `/health` with `status: ok`, and the Socket.IO Engine.IO polling handshake advertising WebSocket support.
- TLS certificate validity and expiry. Fewer than 14 days is a warning; fewer than seven is critical.
- App-host PostgreSQL `SELECT 1`, db/api/web/proxy running state and declared Docker health checks.
- Newly observed container restarts. A restart is critical for an hour after it is observed. Replacing a container with a new deployment ID establishes a new restart baseline.
- App and monitor disk usage. At 70% it reports a warning; at 85% it is critical.
- A completed app backup and a verified monitor copy less than two hours old, plus a successful relay within two hours. Future archive timestamps more than two minutes ahead fail the check.
- App-host DNS/TLS reachability for Yandex geocoder, Google OAuth and FCM. These checks prove network access, not API-key authorization, geocoder quota availability or delivery to a real phone.

Commands have bounded subprocess and HTTP timeouts. Systemd adds an overall service deadline. Persistent per-command locks prevent duplicate local runs. A daily status email is due after 09:00 Asia/Ashgabat, once per local date. It says normal only when every monitored check passes. Warnings produce an attention report instead. Critical failures produce incident emails instead of a normal daily report.

Critical emails are immediate, then at incident age five minutes, at 15 minutes, and every 30 minutes after the preceding successful alert while failure continues. This means minute 0, 5, 15, 45, 75 and so on, subject to timer execution and successful delivery. There is one recovery email after critical checks pass. The first fully healthy run sends a one-time initialization email. Persistent state and Resend idempotency keys prevent repeated successful sends on each timer tick. Failed sends retry on the next timer and do not advance the schedule. Rate limits, an unreachable Resend endpoint, a monitoring VPS outage or a full monitor disk can prevent delivery; the service journal remains the local evidence.

These reports describe the monitored checks. They do not certify release readiness. Real WebSocket upgrade, chat/order notification delivery, Android battery behavior, Yandex authorization, region boundaries and an owner-performed restore drill remain release checks. This is not application exception tracking, and container restart monitoring does not inspect every application error. A second provider or external heartbeat would be needed to alert when both VPSs or the monitor alone become unreachable. The current monitor does not email a separate deployment-success message after each update; initialization and daily reports are supported.

## Restore drill and disaster recovery

Use a separate secure operator/restore computer with Docker, PostgreSQL image, age and the offline identity. Never place the private identity on the app or monitor VPS. Restore into an isolated Compose project, not the production database cluster. The restore command rejects the `tayyn-production` project and requires an explicit `isolated_restore: true` configuration. It creates a new `tayyn_restore_*` database and refuses to replace an existing database.

1. Copy an encrypted archive from Standard S to the secure restore computer, and compare its SHA-256 with the source inventory.
2. Start a disposable PostgreSQL Compose project with a new volume and no published database port. Use service `db`, user `tayyn`, and a synthetic password. Do not reuse production environment files or volumes.
3. Create a private operations config pointing to that disposable compose directory/env file, with a unique `project` such as `tayyn-restore-drill-20261017` and `isolated_restore: true`.
4. Restore with the command below, then query account/region/order counts, balances and ledger/order links. Exercise login, a read-only dashboard and the application version's migrations against the restored copy before accepting the drill.

```sh
python3 scripts/production/operations.py --config /secure/restore-operations.json restore \
  --archive /secure/tayyn-TIMESTAMP-IDENTIFIER.dump.age \
  --identity /secure/tayyn-owner.agekey \
  --database tayyn_restore_verified
```

The restore host temporarily holds decrypted data in a private temporary file, removed when the command exits. Use encrypted local storage. If age authentication fails, no restore database is created. If pg_restore fails after database creation, the disposable partial database remains for diagnosis and the command fails. Do not promote it. Delete only that owned disposable project when the drill is complete.

For actual disaster recovery, stop traffic/writers, provision a replacement app host, restore and validate an isolated copy, rotate compromised credentials if applicable, then perform a separately reviewed database promotion. This tool deliberately does not automate replacing the production database. Record the archive timestamp, restore duration, counts and integrity checks in the production handoff. Test an older retained daily copy periodically too.

## Safe alert and recovery tests

Use a separate synthetic monitor config/state directory and approved test recipient. Point it to an intentionally unavailable synthetic endpoint or block only that test probe to trigger a critical event. Restore that probe and verify a single recovery event. Never delete production tables, fill the production disk or stop a real trip to test monitoring. Mocked repository tests cover cadence, email retry deduplication, failed dumps, corrupted relay archives and restricted commands without sending mail.

```sh
python3 -m unittest discover -s scripts/tests -p 'test_production_operations.py' -v
PATH=/path/to/age/bin:$PATH TAYYN_PRODUCTION_BACKUP_DRILL=1 \
  python3 -m unittest discover -s scripts/tests -p 'test_production_backup_integration.py' -v
```

The opt-in integration drill creates only its randomly named PostgreSQL container and tmpfs data, encrypts a real dump, restores it, compares synthetic ledger rows and verifies tamper rejection. It removes its own Compose project. It never reads Railway credentials or shared databases. Purchased-host delivery, storage and firewall tests still have to run after provisioning.
