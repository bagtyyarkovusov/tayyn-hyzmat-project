# Ubuntu deployment readiness

For the planned production locations, Namecheap DNS, offline installation, update/rollback commands, backups and alert setup, read the [production handoff](production-handoff.md), [offline bundle guide](offline-production-bundle.md) and [operations guide](production-operations.md). These tools are implemented; the purchased-host and clean Ubuntu offline rehearsals remain pending.

The Standard L VPS has been purchased at `216.250.8.238`. Read-only checks on 2026-10-17 verified Ubuntu 24.04.4 amd64, four logical CPUs, 3,915 MiB RAM and about 56 GiB free on the root filesystem. Docker and `age` are not installed. These resources are a sizing candidate for the initial three to five drivers, not a measured capacity guarantee. Provider connectivity and a disposable workload test decide whether it is suitable.

External SSH on port 22 times out, while a temporary SSH listener on port 443 authenticated successfully after console verification of its host key. Yandex, Google OAuth/FCM, GHCR and Let's Encrypt passed DNS/TLS checks from the main host. Resend's IPv4 addresses refused connections, and the agreed `taxi.bagtyyar.dev` hostname did not resolve. Permanent management access, monitoring-host connectivity, DNS/TLS and actual provider delivery remain release gates. See the dated evidence in the [production handoff](production-handoff.md#purchased-host-checks-2026-10-17). No application was deployed during these checks.

## Read-only diagnostic

Requires Python 3.10 or later, with no Python packages. The host check expects the Docker CLI and Compose plugin already installed. It never installs software, starts/restarts containers, reads service logs, changes data, seeds accounts or calls the paid geocoder. Network probes run only with `--network`.

On the prospective Ubuntu host, from the repository directory:

```sh
python3 scripts/production-readiness.py --help
python3 scripts/production-readiness.py \
  --config-file /etc/tayyn/app.env \
  --project-name tayyn-production \
  --compose-file deploy/production/compose.production.yaml \
  --network \
  --api-url https://api.example.com \
  --web-url https://dispatch.example.com
```

Use real HTTPS domains. `--api-url` accepts the direct API origin, or the web proxy base including `/api`. Repeat `--compose-file` for production overrides. `--project-name`, `--db-user` and `--db-name` must match the inspected deployment. `--disk-path` should point to Docker's data filesystem. Files passed as `--config-file` must have owner-only permissions, such as `0600`. Only variable names/presence and permissions are reported; the file is never sourced. This does not validate secret strength, shell interpolation, actual API authorization or whether all variables reach the container.

Save a machine-readable report without changing its exit status:

```sh
python3 scripts/production-readiness.py --network --remote-only \
  --api-url https://api.example.com --web-url https://dispatch.example.com \
  --json > readiness-report.json
result=$?
cat readiness-report.json
exit "$result"
```

For a local shell, omit the last `exit` if you want to keep the session open. Reports include UTC time, inspection scope, individual outcomes and `summary_exit`:

- `0`: implemented required checks passed. This alone does not certify production readiness.
- `1`: at least one failure.
- `2`: required checks incomplete, including the explicitly manual release gates.

`PASS`, `WARN`, `FAIL` and `SKIP` describe each check. Expected release gates currently make an otherwise successful run incomplete. `production_ready` remains false until separate deployment evidence is reviewed. A Mac run can inspect endpoints but cannot establish Ubuntu readiness.

## Railway simulation before purchase

Run `--remote-only --network` with the isolated test API/web URLs. This verifies HTTPS responses and provider DNS/TLS from the machine running the script. **It does not test Railway outbound connectivity.** To inspect outbound reachability from a service host, execute the diagnostic on that host (Python may need to be provided separately); do not expose credentials or install tools in a live service just for this check.

The API `/health` currently proves process liveness only, even when accessed through the web proxy. It does not query PostgreSQL. A local Compose inspection separately executes read-only `SELECT 1` through the `db` service. Remote database readiness remains unverified. HTTPS endpoint probes reject redirects; supply the final HTTPS URL so another page cannot accidentally count as a healthy endpoint. TLS connections to Yandex/Google/GHCR/Resend do not consume geocoder requests and do not establish authorization, quota, successful image pulls, delivery to Android, or connectivity on drivers' networks. API credentials must not be put in command arguments or diagnostic URLs.

## Work required before production

1. Configure production DNS and HTTPS, then test HTTP-to-HTTPS redirection and WebSockets. If Caddy fronts Nginx, review forwarded IP/scheme handling: the production Caddy configuration sends API/Socket.IO requests directly to Express, which trusts one proxy. The base development Nginx path has different forwarding behavior. Expose only intended public ports; keep PostgreSQL private.
2. Wire independent production database/JWT secrets and backend Yandex/FCM configuration at runtime. Base development Compose omits geocoder and FCM variables; the separate production Compose wires them from private runtime configuration. The public browser Maps key is a web build argument; the GHCR workflow passes the repository variable `VUE_APP_YANDEX_MAPS_API_KEY`, which must be configured before the production image build. Keep server credentials out of images, source control and reports.
3. Start fresh with one approved admin and the saved canonical regions. Bootstrap explicitly with a unique password and the approved admin phone. Normal server startup and `prisma migrate deploy` do not seed. Never run synthetic fixtures or copy shared development data into production. A seed run skips an existing matching phone rather than resetting its password. Do not use the fallback seed password.
4. Configure bounded Docker logs, resource monitoring and an external uptime check that can alert when the VPS itself fails. Restart policies recover exited processes/reboots; they do not restart merely unhealthy containers. Current restart counts are not historical crash monitoring. A bounded recovery mechanism must avoid restart loops and alert on repeated failures.
5. Agree on acceptable data loss and recovery time. Automate encrypted off-server database backups, monitor backup age/failures and restore a backup into a disposable database before cutover. Same-host volumes and snapshots alone are insufficient. Protect backup encryption credentials separately. Do not run restore drills against production.
6. Benchmark a disposable deployment using synthetic traffic: GPS uploads, native inbox polls, sockets, simultaneous claims and reconnect bursts. Observe latency, CPU/RAM, database connections, disk growth and errors. Never stress shared Railway or the live database. GPS history currently has no general retention policy; at ten-second updates an eight-hour shift generates about 2,880 positions per driver. Keep trip and ledger history separate from GPS retention decisions.
7. Test production-configured APK endpoints, CORS, precise GPS, disconnect recovery, background notifications and Yandex handoff on a physical phone. The current Railway test APK is not automatically retargeted when the backend moves.

One VPS remains a single point of failure. This diagnostic prepares evidence for a deployment decision; backup restoration, monitoring and real device tests remain required.

## Script verification

```sh
python3 -m unittest discover -s scripts/tests -p 'test_production_readiness.py'
```

The tests exercise timeout handling, private configuration reporting without shell execution, missing Docker, database failure despite healthy containers, HTTPS downgrade rejection, and incomplete remote coverage. They use no live database or network.

## Measurements before purchase, 17 October 2026

The existing isolated Railway `apk-test` environment was inspected without changing configuration, adding fixtures, restarting services or calling paid providers. All three latest deployments were successful. Across 361 four-minute samples over the previous day, the highest same-timestamp sum was 288 MB memory and 0.0182 vCPU for API, web and PostgreSQL. These samples represent light test activity and exclude host, builds and backups. They can miss short peaks.

The database occupied 9.94 MB, while its PostgreSQL volume used about 189 MB including cluster/WAL overhead. A read-only database query passed. Twenty public HTTPS probes from the workstation and fifteen health/Engine.IO probes from the actual Railway API container succeeded. Yandex, Google OAuth/FCM and GHCR were reachable from that container; unauthenticated HTTP responses do not verify keys, account entitlement or notification delivery.

A separate synthetic capacity probe ran the current application from commit `8057fde` in disposable local containers. API limits were one CPU and 512 MiB; PostgreSQL limits were one CPU and 1 GiB. Each fleet ran for roughly one minute, with authenticated sockets, ten-second native GPS/inbox ticks, queue reads and real order creation, competing claims and completion.

| Observation                                 | 5 drivers | 50 drivers |
| ------------------------------------------- | --------: | ---------: |
| Native GPS/inbox request p95                |   85.3 ms |    94.6 ms |
| Available-order request p95                 |   20.5 ms |    22.5 ms |
| API RSS at end                              | 100.7 MiB |  101.2 MiB |
| Completed trips                             |         6 |          6 |
| Expected losing claims, HTTP 409            |         6 |          6 |
| Unexpected HTTP errors / socket disconnects |     0 / 0 |      0 / 0 |

The fifty-driver case reached a sampled 82.76% of one CPU core. This is a short capacity check, not a sustained-load guarantee. It used ARM64 Docker on a Mac, tmpfs database storage and one synthetic region. It excluded durable disk latency, HTTPS/proxies, browsers, real mobile networks, provider delivery and production-cost login bursts. CPU generation and network performance on the purchased VPS remain unmeasured.

The synthetic database was 9.71 MB and its compressed custom-format dump was 94,504 bytes. Dump and restore each took approximately 0.1 seconds on this tiny tmpfs-backed dataset. Restored row counts, order/ledger fingerprints and aggregate balance totals matched. This demonstrates the restore path for these fixtures, not production recovery speed or a future backup-size estimate. Encryption, offsite upload and recovery after server loss still need testing.

After review, the probe was hardened to reject remote Docker endpoints and report cleanup failures. A shorter ten-second rerun with both fleets passed with stronger account, wallet-owner, order-assignment and ledger-linkage digests matching after restore. No benchmark-owned containers remained. The diagnostic's nine regression tests also passed, including secret handling, timeout and false-success prevention.

Reproduce only against a local Docker daemon, with Node 22 and installed repository dependencies:

```sh
node scripts/benchmark-vps.mjs --seconds=60
```

The probe accepts no external URL or database target. It creates uniquely named disposable resources and checks cleanup. Build layers can remain in Docker's cache. Reports are written to ignored `.local/vps-readiness/capacity.json`; the original one-minute run is retained locally as `capacity-60s.json`. Railway observations are in `.local/vps-readiness/railway-baseline.json`. These local files are not required to run the scripts and contain no production credentials.

The initial purchase recommendation is **Standard L: four cores, 4 GB RAM, 60 GB SSD, 403.20 TMT/month**, based on the supplied price sheet. Confirm a public IP, external bandwidth and upgrade options with the provider. Build images in CI, reserve space for logs/WAL and resolve GPS retention before storage grows unchecked. Re-run the checks on the purchased host and test a driver's actual network before moving production.

## Backup size and acceptable loss

Backup size determines transfer time, storage cost and part of restore time. The interval determines how much recent data can be lost. Even a tiny database backed up once daily can lose almost a full day of orders and balance changes.

Hourly encrypted dumps are the simplest starting mechanism if losing up to an hour is acceptable. A five-minute loss target requires more frequent verified backups or PostgreSQL WAL archiving with a tested base backup. WAL storage can exceed compressed logical-dump size. Choose the acceptable loss and recovery time first, then measure backup growth under real shifts and set retention. The 94 KB fixture dump must not be used as a production storage forecast.
