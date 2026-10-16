# Dispatch pilot

The pilot coordinates dispatcher-created rides and driver claims within regions.

## Language

**Dispatcher**: A staff member who enters an order and chooses its region.

**Driver**: An approved participant who receives available orders and carries out a claimed order.

**Region**: A dispatch area used to group drivers and orders. “District” and “zone” in inherited code refer to this concept.

**Order**: A request entered by a dispatcher, progressing from available through a driver claim to completion or cancellation.

**Claim**: A driver's successful acceptance of an available order.

**Synthetic balance**: A development-only account balance used to exercise charges and refunds without real money transfers.

**TMT**: Turkmen manat, the pilot's only currency.

**Private offer**: A dispatcher reservation for one eligible driver, requiring explicit confirmation within 20 seconds.

**Reservation deadline**: The server-persisted time after which a private offer releases to its original region’s public queue; reloads never extend it.
