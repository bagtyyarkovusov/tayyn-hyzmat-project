# Dispatcher alerts and Activity, October 2026

Prepared for deployment. This updates the dispatcher dashboard and server. Drivers keep the existing 1.20 app; no new APK is needed. Existing accounts, regions, orders, chats and balances are preserved.

## English

- Messages from different drivers have separate alert rows. Up to three drivers appear at once, with a link to all messages.
- Canceled orders stay visible until a dispatcher resolves them. Up to three appear at once, with a link to all cancellations.
- Message and cancellation alerts fit together without covering each other.
- Messages and cancellations use different short sounds. Rapid arrivals are grouped, and changing screens does not play the same alert again.
- Activity keeps cancellations, orders offered again, final cancellations, driver approvals and blocks, and balance changes. Entries show the person and time, plus the order number and a link when relevant.

Older driver approval and block history includes only the last facts the system retained. Earlier transitions cannot be recovered. Browser sound depends on the browser allowing audio and the computer's sound settings.

## Русский

Обновляются панель диспетчера и сервер. Водителям можно продолжать пользоваться приложением 1.20. Новый APK устанавливать не нужно. Аккаунты, регионы, заказы, переписка и балансы сохраняются.

- Сообщения от разных водителей показываются отдельными строками. Одновременно видны до трёх водителей и ссылка на все сообщения.
- Отменённые заказы остаются в уведомлениях, пока диспетчер не примет решение. Видны до трёх заказов и ссылка на все отмены.
- Уведомления о сообщениях и отменах не перекрывают друг друга.
- Для сообщений и отмен используются разные короткие звуки. События, пришедшие почти одновременно, объединяются. Переход между экранами не повторяет звук.
- В разделе «Активность» сохраняются отмены, повторные предложения заказа, окончательные отмены, одобрения и блокировки водителей, а также изменения баланса. Запись показывает участника и время, а при необходимости номер заказа и ссылку на него.

Старая история одобрений и блокировок содержит только последние сведения, которые система сохранила. Более ранние изменения восстановить нельзя. Звук зависит от разрешения браузера на воспроизведение и настроек звука компьютера.

## Validation and deployment

Implementation source: `09a42ed`; the following documentation commit `7f07e92` records the final browser results.

- Full isolated browser suite: 196/196 passed in 7.6 minutes, zero failures, runner exit 0. Focused alert suite: 32/32 passed.
- Backend disposable integration suite: 181/181 passed. Unit suite: 7/7 passed. The exact resolved-cancellation identity follow-up passed 2/2 targeted tests.
- Frontend and backend typecheck, formatting, and modern plus legacy web builds passed. Final release checks are recorded in the PR before merge.
- Review fixes cover live Activity updates after approval/block, Activity links to canceled orders, and delayed old resolutions preserving a newer cancellation alert.

Detailed evidence: [UI verification](../plans/dispatcher-alerts-activity-ui.md) and [backend contract and verification](../../backend/docs/dispatcher-alerts-activity.md). Screenshots and raw local logs contain synthetic data only.

Deployment is a separate data-preserving server update after required checks pass. The additive migration creates the driver activity audit table and copies retained approval/block facts. The normal updater takes a fresh encrypted backup before migration. The existing 1.20 APK remains compatible. No production reset or native rebuild belongs to this update.
