# Pilot decisions

Agreed with the owner on 2026-10-15.

- Initial scope is dispatcher and driver workflows. Customer self-booking is out of scope.
- Start with one dispatcher and 3–5 drivers, using mobile browsers before Android testing.
- The dispatcher creates an order for a specific region. Eligible drivers in that region receive a realtime notification and claim an available order themselves.
- Drivers should claim orders only in their region.
- Keep balances and commission flows for testing, entirely synthetic. TMT is the only currency. No real payments.
- Another developer is drawing the real regions. Their editing environment and saved boundaries must remain untouched.
- Use a separate local container stack and database for an approximate synthetic zone until real boundaries are ready.

## Existing behavior to reconcile

`backend/src/modules/orders/orders.service.js` currently permits claiming an open order from another region. The current query in `accept()` has no district restriction, despite an older nearby comment claiming otherwise. Enforcing the agreed restriction is a required application change before pilot acceptance; the synthetic-zone setup does not fix it. Viewing other regions' queues is also currently supported.

Realtime notifications currently use Socket.IO. This does not establish reliable delivery when a mobile browser is backgrounded or closed. Native push remains a later Android task.

The backend falls back to the nearest center when a coordinate is outside all saved polygons. A saved test rectangle therefore does not by itself reject orders or drivers outside its perimeter. Service-area enforcement is a separate decision.
