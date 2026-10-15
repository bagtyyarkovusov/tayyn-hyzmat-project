# Browser workspace design

Dispatcher and driver surfaces use Operate mode. The primary tasks are assigning orders to regions and taking a regional order through its existing lifecycle. Interfaces remain in Russian and show TMT only.

The visual direction uses the order and legibility of a city public-service information sheet: warm stone background, forest-green actions, ink typography, ruled lists and consistent status text. It replaces the inherited gradients and duplicated role styling. Manrope Variable is self-hosted, including Cyrillic. Light, dark and system settings follow the real usage scene: dispatcher desks and drivers outdoors or at night.

The grounded alternatives considered were a municipal information sheet, a street atlas, a public-service information sheet, a numbered delivery register, a rail timetable, a local newspaper and a printed road directory. The direction roll assigned the third. Airline coupons were competitive on workflow clarity but less familiar; their explicit cancelled state is retained as a discipline. Goldenrod slides, catalog thumbnails, airport signs and split-flap boards were declined because forced shapes or oversized codes reduce order scanning; the selected direction retains their fixed alignment, consistent state marks and clear destinations without their costumes.

Dispatcher navigation remains visible on desktop and scrolls horizontally on narrow screens. Driver navigation stays reachable at the bottom. Lists expose the actual operational content; views prioritize the next action, current state and recovery over decorative metrics. Forms use labels, actionable errors and pending guards. Destructive or charging operations require clear intent. Shared primitive components come from the official shadcn-vue registry and use the semantic tokens in `src/shared/theme.css`.

No real regions, credentials or operational claims belong in design fixtures. Map vendor failures retain usable lists and explain recovery. Live connection status is distinct from a guaranteed background notification service.
