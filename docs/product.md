# Pilot scope and open questions

## Agreed scope

Start with one dispatcher and three to five drivers. The dispatcher adds an order to a chosen region; eligible drivers in that region receive a notification and claim available orders. Customer self-booking and Android-specific work are outside this phase.

Drivers must explicitly accept orders. Receiving an offer or leaving it open for five minutes never claims it or charges the balance. Hiding an offer is a local dismissal. Offer expiration and expansion timing remain separate unresolved policies.

Dispatcher order creation requires a selected region, a valid customer phone and a manually entered positive price in TMT. Customer phone fields start with +993. Addresses, map coordinates and notes are optional. After accepting, the driver calls the customer to agree on pickup details. Customer phones remain hidden from drivers before acceptance. Inherited orders without a quoted price do not debit the synthetic balance; existing quoted-price charging and refund behavior remains in place. Region-centre coordinates may be stored as a fallback and must not be presented as an exact customer pickup.

Dispatch priority must reflect available evidence. An order without an exact pickup pin can be offered to eligible drivers in its selected region, but must not be described as geographically closest. An actual pickup pin and fresh driver GPS may support proximity ranking. The offer strategy, eligibility rules and fallback behavior are still unresolved; no priority algorithm is introduced by this migration.

Use fresh synthetic data, synthetic balances, no real payments, and TMT only. Test in mobile browsers first. Keep the supporting developer's current region editing environment intact; fixtures and test writes belong only in isolated environments. Fresh environments may load the saved canonical region defaults without overwriting existing boundaries.

Dispatchers can create approved driver accounts with a name, phone, password and region. New accounts start offline with a zero synthetic TMT balance; top-ups use the existing driver balance controls. First-device binding and later device approval continue to apply. Phone inputs start with +993 and remain editable.

## Unresolved questions

- Which offer strategy and driver eligibility rules should be used, and what should happen when pickup or fresh driver GPS is unavailable?

- Should a pickup outside every polygon be refused, or assigned by nearest center?
- What does the quoted price represent, and how much should acceptance debit from a driver's balance?
- What delivery guarantee is required when a browser is suspended or closed?

Record answers here when settled, and use ADRs for resulting architectural choices. Track implementation gaps in GitHub Issues. [Architecture](architecture.md) distinguishes current behavior from this agreed scope.
