# Tayyn Hyzmat flow diagrams in English

The diagrams use the approved state model. Solid paths describe `main` today. Dashed paths are the approved public-expansion change still under review in PR #79.

## Driver readiness and shift

```mermaid
stateDiagram-v2
  [*] --> GPS_off: permission or system location off
  GPS_off --> GPS_acquiring: driver opens location settings
  GPS_acquiring --> GPS_ready: fresh local fix
  GPS_ready --> GPS_stale: fix expires
  GPS_stale --> GPS_ready: new local fix
  GPS_ready --> Connecting: driver taps Online
  Connecting --> Online: API, Socket.IO, and first report confirmed
  Connecting --> Offline: no network or server confirmation
  Online --> Reconnecting: network or GPS interruption
  Reconnecting --> Online: lease and fresh report restored
  Reconnecting --> Offline: 60-second lease expires
  Online --> Offline: driver taps Offline, logout, force-close
  Offline --> GPS_ready: local GPS remains enabled
```

A green GPS marker means a fresh local fix. A green Online control means the server has accepted the shift. The second signal must not be inferred from the first.

## Order creation and offer choice

```mermaid
flowchart TD
  A[Dispatcher opens new order] --> B{Region + phone + positive TMT price valid?}
  B -- no --> B1[Show field error]
  B -- yes --> C{Offer mode}
  C -- Public --> D[Publish to regional queue]
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
    S-->>O: order:taken, remove offer
  else Decline or deadline expires
    S->>S: Release reservation
    S-->>V: Offer ended
    S-->>O: Public queue update
  end
```

The current public update returns the order to its original region. The approved pending branch adds this choice:

```mermaid
flowchart LR
  X[20-second private deadline] --> Y{Dispatcher enabled expansion?}
  Y -- no --> Z[Stop unassigned]
  Y -- yes --> P[Open in every region at once]
  P --> Q[First valid claim wins]
  Q --> R[Broadcast order:taken to everyone]
```

There is no second timer after expansion.

## Balance and trip lifecycle

```mermaid
stateDiagram-v2
  [*] --> Public
  Public --> Reserved: private offer
  Public --> Accepted: first valid public claim
  Reserved --> Accepted: selected driver accepts before 20s
  Reserved --> Public: decline or expiry
  Accepted --> Waiting: driver arrives
  Waiting --> Started: customer boards
  Waiting --> Cancelled: driver or dispatcher cancellation
  Started --> Completed: driver completes
  Started --> Resolved: dispatcher force-resolves with reason
  Accepted --> Cancelled: dispatcher cancellation
  Completed --> [*]
  Cancelled --> [*]
  Resolved --> [*]
```

The quoted amount is charged once at acceptance. Completion does not charge again. A driver cannot cancel after `Started`. A lost connection keeps an accepted trip assigned while new work is blocked.

## Location, address, and dispatcher map

```mermaid
flowchart TD
  G[Fresh GPS report] --> R{Inside saved polygon?}
  R -- yes --> RI[Assign region]
  R -- no --> RO[Show Outside region + live coordinates]
  RI --> M[Dispatcher map and roster]
  RO --> M
  M --> V{Location visible to a dispatcher?}
  V -- yes --> L[Optional address lookup under shared budget]
  V -- no --> C[Keep GPS only]
  L --> A[Show address if fresh]
  L --> C[On quota/provider failure show coordinates]
```

GPS remains authoritative. Address text never controls eligibility.

## Android delivery and recovery

```mermaid
sequenceDiagram
  participant U as Driver
  participant A as Android service
  participant S as Server
  participant N as Notification channel

  U->>A: Grant location and notification permissions
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
  else logout, force-close, task swipe
    A->>S: End shift when possible
  end
```

The server deadline is authoritative. Doze, battery saver, or manufacturer limits can delay a notification and must be tested on a physical Infinix Android 14 phone.
