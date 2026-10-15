# Pilot scope and open questions

## Agreed scope

Start with one dispatcher and three to five drivers. The dispatcher adds an order to a chosen region; eligible drivers in that region receive a notification and claim available orders. Customer self-booking and Android-specific work are outside this phase.

Dispatcher order creation requires only a selected region and a valid customer phone. Addresses, map coordinates, quoted price and notes are optional. After accepting, the driver calls the customer to agree on pickup details. Customer phones remain hidden from drivers before acceptance. Orders without a quoted price do not debit the synthetic balance; existing quoted-price charging and refund behavior remains in place. Region-centre coordinates may be stored as a fallback and must not be presented as an exact customer pickup.

Use fresh synthetic data, synthetic balances, no real payments, and TMT only. Test in mobile browsers first. Keep the supporting developer's current region editing environment intact; our guessed region belongs only in an isolated environment.

## Unresolved questions

- Should a pickup outside every polygon be refused, or assigned by nearest center?
- What does the quoted price represent, and how much should acceptance debit from a driver's balance?
- What delivery guarantee is required when a browser is suspended or closed?

Record answers here when settled, and use ADRs for resulting architectural choices. Track implementation gaps in GitHub Issues. [Architecture](architecture.md) distinguishes current behavior from this agreed scope.
