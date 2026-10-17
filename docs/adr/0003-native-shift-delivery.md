# Deliver on-shift Android alerts without Firebase

The notification, readiness and task-removal choices below are superseded by [ADR 0005](0005-separate-notification-delivery-from-shifts.md). The location foreground service and server lease remain in use.

Use a user-started Android location foreground service, a dedicated opaque server lease and native notification channels for driver shifts. A local Capacitor bridge owns this service because browser geolocation and timers cannot own background execution; adding a notification plugin alone would not provide background delivery. The service polls the authorized canonical order/chat inbox every 10 seconds using our existing API and persisted entities, so reconnect can reconcile stable event IDs without a second push provider.

The lease lasts 60 seconds and cannot be revived after expiry. Credentials stay in process memory, the service is not sticky, and task removal requests shift termination; force-stop or process death falls back to server expiry. Native notification/GPS readiness gates Online in this implementation. Android Doze and vendor power management can still delay delivery, including a 20-second private offer, so locked-screen/device measurements remain release requirements rather than a delivery guarantee.
