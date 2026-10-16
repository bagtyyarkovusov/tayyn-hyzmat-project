# Tayyn Hyzmat progress brief

The team moved the pilot from a rough browser prototype to a testable dispatcher and driver service.

Dispatchers can create orders with a phone number, region, and TMT price, then send an order to everyone or to one selected driver. Drivers see live region counts, receive offers, and accept them explicitly. The system prevents underfunded acceptance and prevents negative balances. We also added a safer way for a dispatcher to resolve a trip that was left open after it started.

The map and driver roster now work together. A dispatcher can find a driver, see the last reported position, and open driver actions without a full-screen list reload. GPS decides region eligibility. Address lookup is optional and will fall back to coordinates when its provider or quota is unavailable.

The test APK and browser workflows cover the main order, private-offer, balance, refund, chat, and recovery paths. The shared Railway deployment contains the merged work. GitHub cleanup removed superseded work while leaving active follow-ups visible.

Before release, the remaining checks are the new online readiness states, the standalone driver login page, private-offer expansion after 20 seconds, production address-quota configuration, Today analytics, and a physical Infinix Android 14 test with the screen locked and battery saving enabled. No real payments are enabled in this test phase.
