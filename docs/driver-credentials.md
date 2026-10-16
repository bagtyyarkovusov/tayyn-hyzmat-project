# Driver credential management

Dispatchers open a driver profile to edit their name and login phone or reset their password. Password reset requires matching entries of at least eight characters. Passwords exceeding bcrypt's 72-byte limit are rejected, rather than silently truncated. No endpoint returns an existing password or hash.

Name-only changes preserve sessions. Changing the phone or password increments the user's credential version and takes the driver offline in the same database transaction. Existing access tokens, refresh tokens, and socket connections then lose access. Approved devices, synthetic balances and accepted trips are retained. The driver signs in with the new credentials and enables GPS before going online again.

Duplicate phones roll back the entire profile edit. Concurrent dispatcher changes serialize on the user row. A login or refresh that began before a reset can only issue credentials with its captured old version, which authentication rejects after the reset.

## Deployment and rollback

Apply migration `20261015000000_driver_credential_versions` before starting the new backend. It adds integer columns with constant zero defaults to users and refresh tokens, without deleting data. Previously issued access tokens without a version represent version zero. They work until that user's credentials change.

Keep both columns on rollback. Rolling back to a backend without version validation restores the authority of old access tokens until expiry, so it is not a safe rollback after credential changes. Fix forward, or stop the service and rotate the access-token signing secret before deploying older code. Session revocation cannot be undone by decrementing versions.

## Native shift integration gate

This branch predates the native shift implementation in issue #26. Its driver-offline update prevents the proposed native renewal check, but the combined branches must also capture the credential version when starting a lease, validate it on every native request, and call `revokeUserShift` after credential changes. Otherwise an old lease might regain authority if the driver later comes online. Do not release the combined APK until that integration and a reset during a running shift are tested.

## Verification

Tests use HTTP, Socket.IO and browser workflows with disposable synthetic databases. They cover role guards, name-only session preservation, invalid input, duplicate-phone rollback, immediate access/refresh/socket revocation, re-login, approved-device retention and active-trip/balance recovery. Native background notification behavior is a separate release gate.
