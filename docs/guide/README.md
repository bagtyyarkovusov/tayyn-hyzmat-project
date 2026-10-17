# Tayyn Hyzmat operating guides

These guides explain the current dispatcher and driver workflows in plain language. They are written for people who run the service, test it, or support drivers.

- [English operating guide](operations.en.md)
- [Русское руководство](operations.ru.md)
- [English flow diagrams](flows.en.md)
- [Диаграммы потоков на русском](flows.ru.md)
- [Release evidence and remaining device checks](../releases/2026-10-16-pilot-evidence.md)
- [Client release brief](client-brief.en.md)
- [Краткая записка для клиента](client-brief.ru.md)
- [English client tutorial, HTML](export/tayyn-guide.en.html) and [PDF](export/tayyn-guide.en.pdf)
- [Руководство для клиента, HTML](export/tayyn-guide.ru.html) и [PDF](export/tayyn-guide.ru.pdf)

The guides track the workflows in this repository. Deployed behavior depends on the installed APK and deployed backend release. A section named **Pending** means the behavior is planned or under review and is not a promise about the deployed build. The canonical region polygons live in [`docs/regions.md`](../regions.md). Development and release checks live in [`docs/development.md`](../development.md), [`docs/testing.md`](../testing.md), and [`docs/android.md`](../android.md).

The client HTML/PDF editions contain twelve pages per language, including a separate explanation of cancellation and completion. Keep both exports synchronized when operating rules change. Their diagrams are rendered inside the document and do not need an external diagram service.

The current candidate adds pages for profile history, notification settings and account/shift access. Android background delivery still needs target-phone verification; the Yandex quota resets at midnight Moscow time; isolated API variable readback confirms the 1,000-request daily allocation with a 00:00 Europe/Moscow reset, while shared development remains disabled. An authenticated deployed lookup still needs verification.

The final grid/address page explains available public orders versus drivers on shift, independent green/blue signals, and driver-only convenience lookup before the shift, a fresh lookup after Online, then five-minute updates in the visible home-screen location view. Background views pause; one due catch-up and manual refresh share server limits across devices.
