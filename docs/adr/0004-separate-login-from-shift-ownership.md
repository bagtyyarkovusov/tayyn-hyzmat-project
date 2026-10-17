# Separate login from shift ownership

An approved driver account may remain signed in on several installations, but only one device can own the driver's active shift. Account approval remains required, while separate device approval is removed. A login must not interrupt a working phone; shift ownership is acquired atomically and checked separately for GPS uploads, availability and order actions, so a second signed-in device cannot move the driver or act on the working device's orders.

Logging out ends only that device's sessions and its own shift. Password or phone changes and account blocking still revoke all devices. Device identity is bound to server-issued credentials; a request cannot gain shift control by naming another device in its body. This replaces the previous policy where switching the most recently logged-in device revoked the whole account's sessions.

Devices here mean app installations or browser profiles, not verified physical phones. This policy does not impose a phone-wide restriction across separate driver accounts, cloned apps or browsers.

Off-shift location stays local to the phone. Online submits a fresh fix and acquires ownership in one transaction, so two signed-in phones cannot race to overwrite the account location before either starts work. Only the active owner uploads recurring GPS. Explicit Offline stops these uploads even during a trip; the dispatcher keeps a timestamped last location and the assigned trip remains assigned. The local GPS indicator is independent of the network and server shift.

The dispatcher retains one account-wide Sign out everywhere action instead of a device list. It revokes access and ends the shift while preserving the assigned trip, password and balance. Temporary Block requires a reason and immediately revokes access, even on a trip; it does not perform an order cancellation, refund or reassignment. Delete is permanent, keeps historical records, and is refused until trips are resolved. Reusing the released phone creates a new pending account with no inherited balance or history. These are separate account actions so a security response cannot silently change the order ledger.
