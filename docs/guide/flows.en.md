# Tayyn Hyzmat flow diagrams in English

Each diagram states whether it describes the current implementation or an approved change. Readiness-state separation and all-region expansion are in the merged release contract.

## Driver readiness and shift

Merged readiness contract (#85, `2095f56`). Hardware and background checks on the target Android phone remain release verification.

```mermaid
stateDiagram-v2
  [*] --> GPS_off: permission or system location off
  GPS_off --> GPS_acquiring: driver opens location settings
  GPS_acquiring --> GPS_ready: fresh local fix
  GPS_ready --> GPS_stale: fix expires
  GPS_stale --> GPS_ready: new local fix
  GPS_ready --> Connecting: driver taps Online
  Connecting --> Online: fresh fix and ownership accepted atomically
  Connecting --> Offline: no network or server confirmation
  Online --> Reconnecting: network or GPS interruption
  Reconnecting --> Online: lease and fresh report restored
  Reconnecting --> Offline: 60-second lease expires
  Online --> Offline: driver taps Offline or logs out
  Offline --> GPS_ready: local GPS remains enabled
```

A green GPS marker means a fresh local fix. A green Online control means the server has accepted the shift. The second signal must not be inferred from the first.

## Order creation and offer choice

```mermaid
flowchart TD
  A[Dispatcher opens new order] --> B{Region + phone + positive TMT price valid?}
  B -- no --> B1[Show field error]
  B -- yes --> C{Offer mode}
  C -- Public --> D[Publish globally; popup only in original region]
  C -- Private --> E[Choose online idle driver]
  E --> F{Fresh GPS and enough balance?}
  F -- no --> F1[Explain why private offer cannot start]
  F -- yes --> G[Persist private reservation and 20-second deadline]
```

Map and address fields are optional. A private selection does not change the order's region.

## Private offer and first claim

```mermaid
sequenceDiagram
  participant D as Dispatcher
  participant S as Server
  participant V as Selected driver
  participant O as Other drivers

  D->>S: Create private offer
  S->>V: Safe offer, deadline = now + 20s
  V->>S: Accept or decline
  alt Accept before deadline
    S->>S: Lock order and driver, charge quoted TMT once
    S-->>V: Accepted, reveal customer phone
    S-->>O: order:taken, remove offer and decrease available count
  else Decline before deadline
    S->>S: Stop private delivery; preserve deadline
    S-->>V: Offer ended
    Note over S,O: No public visibility before original deadline
  else Deadline expires
    S->>S: Release reservation
    alt Expansion enabled
      S-->>O: Open in every region
    else Expansion disabled
      S-->>O: Keep order unassigned
    end
  end
```

After a private offer expires, the dispatcher choice controls the next state:

```mermaid
flowchart LR
  X[20-second private deadline] --> Y{Dispatcher enabled expansion?}
  Y -- no --> Z[Stop unassigned]
  Y -- yes --> P[Open in every region at once]
  P --> Q[First valid claim wins]
  Q --> R[Broadcast order:taken to everyone]
```

There is no second timer or incoming popup after expansion. Public announcements are immediately claimable globally; the original region alone receives the 20-second popup.

## Balance and trip lifecycle

```mermaid
stateDiagram-v2
  [*] --> Public
  Public --> Cancelled: dispatcher cancellation before acceptance
  Public --> Reserved: private offer
  Public --> Accepted: first valid public claim
  Reserved --> Accepted: selected driver accepts before 20s
  Reserved --> Reserved: early decline; stop delivery until deadline
  Reserved --> Public: expiry with expansion
  Reserved --> Stopped: expiry without expansion
  Accepted --> Waiting: driver arrives
  Waiting --> Started: customer boards
  Waiting --> Cancelled: driver or dispatcher cancellation
  Started --> Completed: driver completes
  Started --> Completed: dispatcher force-completes with reason
  Accepted --> Cancelled: dispatcher cancellation
  Completed --> [*]
  Cancelled --> [*]
```

The server enforces the actor-specific cancellation path shown here. The driver can cancel only in Waiting. The dispatcher can cancel before Started, including New and Accepted. Started has no ordinary cancellation path. Force-resolution records a completed order, not a separate status. The quoted amount is charged once at acceptance. Completion does not charge again or refund it. A lost connection keeps an accepted trip assigned while new work is blocked.

## Region grid and live claims

```mermaid
flowchart TD
  O[Unassigned public order] --> C[Left count: available orders in its region]
  S[Driver shift on, free or busy] --> D[Right count: working drivers in that region]
  C --> G[Green card when left count is above zero]
  L[Fresh usable local GPS] --> I{Internet connected and inside saved polygon?}
  I -- yes --> B[Blue border on this phone's current region, even off shift]
  I -- no --> N[No blue border; GPS may still be green]
  A[First valid claim] --> R[Remove order from every queue and decrease left count]
  R --> T[Trip remains assigned; it is not an available order]
```

Blue identifies this phone's region; green identifies available work. Neither colour transfers a shift or replaces server claim validation. Live counts and order actions require an active shift.

## Location, address, and dispatcher map

```mermaid
flowchart TD
  G[Fresh precise local GPS + internet + visible home-screen location view] --> C{Convenience attempt used on this installation?}
  C -- no --> O[One off-shift address using transient point]
  C -- yes --> L[Local coordinates; do not repeat convenience request]
  O --> N[No shared tracking or dispatcher map update]
  S[Explicit Online succeeds and owns shift] --> A[Fresh address; one exception to convenience cooldown]
  A --> V{Foreground and connected?}
  V -- yes --> D{Five minutes due?}
  D -- yes --> Q[One budgeted refresh; no movement requirement]
  D -- no --> W[Wait without spending quota]
  V -- no --> P[Pause address requests; GPS service stays separate]
  P --> V
  Q --> V
  M[Dispatcher] --> X[Region, coordinates and position age; no address requests]
```

The server remembers convenience attempts and enforces a shared driver cooldown, daily reserve and provider backoff. Repeated Online taps cannot repeat the one-time exception. Foreground/reconnect catches up once if due, never replays missed intervals. Manual refresh shares the same limit. Address failure never blocks work.

## Android delivery and recovery

```mermaid
sequenceDiagram
  participant U as Driver
  participant A as Android service
  participant S as Server
  participant N as Notification channel

  U->>A: Grant precise location; notifications are optional
  U->>A: Tap Online in visible app
  A->>S: Fresh GPS and start shift
  S-->>A: 60-second lease
  loop while on shift
    A->>S: Renew lease and poll order/chat inbox
    S-->>N: New event
  end
  alt network loss
    A->>S: Retry
    S-->>A: Lease expires after 60s if no accepted report
  else explicit Offline or logout
    A->>S: End shift when possible
  end
```

Swiping the task away preserves the shift. Android Force stop blocks delivery until reopening; without reports the lease expires. After failed 60-second recovery, the driver must tap Online again. Notification permission never gates the shift.

The server deadline is authoritative. Doze, battery saver, or manufacturer limits can delay a notification and must be tested on a physical Infinix Android 14 phone.

## Chat on signed-in devices

```mermaid
flowchart TD
  M[Message saved on server] --> S[Socket.IO to signed-in devices]
  S --> V{Conversation visible?}
  V -- yes --> Q[Update quietly and acknowledge read]
  V -- no --> P[Show preview outside chat]
  M --> F[FCM fallback for missed or background delivery]
  F --> C[Fetch current event and check notification preference]
  C --> N[Show valid alert; deduplicate by event ID]
  Q --> R[Clear corresponding unread alerts across devices]
```

Chat does not require GPS or an active shift. Profile has one notification switch; it does not block shift start. Android permission and network or battery restrictions still apply.

## Account approval and one shift owner

The candidate keeps account approval and removes separate device approval.

```mermaid
flowchart TD
  A[Approved driver signs in on phone B] --> B{Phone A owns active shift?}
  B -- yes --> C[Allow chat and viewing; block second shift]
  B -- no --> D[Phone B may request Online with fresh GPS and connection]
  C --> E[Wait for A Offline, logout or 60-second expiry]
  E --> D
  F[Dispatcher: Sign out everywhere] --> G[Revoke all sessions and end shift]
  G --> H[Keep assigned trip, password and balance]
```

For a lost phone, reset the password too. Signing out alone does not prevent a new login with the same password.

## Account access and local location

```mermaid
flowchart TD
  A[Approved account signs in on any phone] --> B[Off-shift GPS never changes shared tracking]
  B --> C[Tap Online with fresh fix]
  C --> D{Another phone owns shift?}
  D -- yes --> E[Reject start; preserve working phone]
  D -- no --> F[Atomically save GPS and grant shift]
  F --> G[Only owner reports positions]
  G --> H[Explicit Offline stops reporting; trip stays assigned]
```

```mermaid
flowchart TD
  A[Dispatcher account action] --> S[Sign out everywhere]
  S --> P[End sessions and shift; preserve trip/password/balance]
  A --> B[Temporary Block with reason]
  B --> C[Revoke access immediately; preserve assigned trip]
  C --> U[Unblock permits new login]
  A --> D{Delete account: unfinished trip?}
  D -- yes --> R[Refuse; resolve trip first]
  D -- no --> X[Remove access permanently; retain old records]
  X --> N[Same phone may make new application]
  N --> Q[New approval; zero balance; separate history]
```
