# Separate notification delivery from shifts

Use Firebase Cloud Messaging as an Android delivery fallback for our persisted notification events, with Socket.IO delivery and acknowledgements while connected. Accounts, messages, read state, order deadlines and claims remain in our backend. Approved signed-in installations register separately so chat can reach every device with GPS and shift off, while order alerts still require the eligible shift owner.

This supersedes the notification and task-removal choices in [ADR 0003](0003-native-shift-delivery.md). The native foreground service still owns on-shift GPS and the renewable 60-second server lease. Swiping away the task keeps that service running; explicit Offline or logout stops it. Notification permission and the Profile mute control do not gate availability. Force stop and an expired server lease still require reopening and explicitly starting a shift again.

Use one native notification coordinator for socket, poll and FCM arrivals, with stable event IDs, expiry checks and authenticated recovery. A notification never claims an order. FCM cannot guarantee delivery within a private offer's 20-second window, and platform/network behavior must be verified on the pilot phones.
