# Pilot scope and open questions

## Agreed scope

Start with one dispatcher and three to five drivers. The dispatcher adds an order to a chosen region; eligible drivers in that region receive a notification and claim available orders. Customer self-booking and Android-specific work are outside this phase.

Drivers must explicitly accept orders. Receiving an offer or leaving it open for five minutes never claims it or charges the balance. Hiding an offer is a local dismissal. Offer expiration and expansion timing remain separate unresolved policies.

Dispatcher order creation requires a selected region, a valid customer phone and a manually entered positive price in TMT. Customer phone fields start with +993. Addresses, map coordinates and notes are optional. After accepting, the driver calls the customer to agree on pickup details. Customer phones remain hidden from drivers before acceptance. Inherited orders without a quoted price do not debit the synthetic balance; existing quoted-price charging and refund behavior remains in place. Region-centre coordinates may be stored as a fallback and must not be presented as an exact customer pickup.

Dispatch priority must reflect available evidence. An order without an exact pickup pin can be offered to eligible drivers in its selected region, but must not be described as geographically closest. An actual pickup pin and fresh driver GPS may support proximity ranking. The offer strategy, eligibility rules and fallback behavior are still unresolved; no priority algorithm is introduced by this migration.

Use fresh synthetic data, synthetic balances, no real payments, and TMT only. Test in mobile browsers first. Keep the supporting developer's current region editing environment intact; fixtures and test writes belong only in isolated environments. Fresh environments may load the saved canonical region defaults without overwriting existing boundaries.

Dispatchers can create approved driver accounts with a name, phone, password and region. New accounts start offline with a zero synthetic TMT balance; top-ups use the existing driver balance controls. First-device binding and later device approval continue to apply. Phone inputs start with +993 and remain editable.

The driver home shows every region in a fixed viewport grid. Each card shows only its name and a cars:orders score. Cars counts approved online drivers, including those on a trip; orders counts active orders until completion or cancellation. Trip controls, incoming offers and order lists open in dialogs so the regional overview does not grow. The home location row is read-only and uses browser GPS coordinates; manual region selection is removed from this screen. Region counts update through Socket.IO. Open order lists refresh on global region updates, reconnect and returning to the foreground; the home refresh control is removed. Active trips and balances restore from the backend after reload. Arrival selection is kept while an open list updates, and resets when that list is closed. A full-width active-trip strip above the grid reopens trip controls. Availability changes use brief visual feedback with reduced-motion support. Drivers must enable browser GPS and successfully report a fresh position before going online, viewing available orders or claiming them. Coordinates expire after 60 seconds; expiry takes the driver offline and stops new offers, while accepted-trip controls remain available. Restoring GPS requires explicitly going online again. Development uses browser GPS emulation; a separate in-app simulator remains future work.

Driver and dispatcher chat keep the app header, composer and navigation inside the visible viewport. Message history scrolls independently. Enter sends, Shift+Enter adds a line, and text composition never submits a message. Empty or pending messages cannot be submitted; a failed send preserves its draft. Incoming messages follow the bottom only while the reader is already near it. Theme selection uses an icon dropdown with persisted system, light and dark preferences.

## Unresolved questions

- Which offer strategy and driver eligibility rules should be used, and what should happen when pickup or fresh driver GPS is unavailable?

- Should a pickup outside every polygon be refused, or assigned by nearest center?
- What does the quoted price represent, and how much should acceptance debit from a driver's balance?
- What delivery guarantee is required when a browser is suspended or closed?

Record answers here when settled, and use ADRs for resulting architectural choices. Track implementation gaps in GitHub Issues. [Architecture](architecture.md) distinguishes current behavior from this agreed scope.
