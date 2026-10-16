# Separate login from shift ownership

A driver may remain signed in on several approved devices, but only one device can own the driver's active shift. Login and device approval must not interrupt a working phone; shift ownership is acquired atomically and checked separately for GPS uploads, availability and order actions, so a second signed-in device cannot move the driver or act on the working device's orders.

Logging out ends only that device's sessions and its own shift. Password or phone changes and account blocking still revoke all devices. Device identity is bound to server-issued credentials; a request cannot gain shift control by naming another device in its body. This replaces the previous policy where switching the most recently logged-in device revoked the whole account's sessions.

Devices here mean app installations or browser profiles, not verified physical phones. This policy does not impose a phone-wide restriction across separate driver accounts, cloned apps or browsers.
