# OpenRide Backend

Собственный backend для OpenRide, заменяющий Firebase (Auth/Realtime Database/Storage) и Airtable.
Стек: Node.js + Express + PostgreSQL + Prisma ORM + Socket.IO + JWT.

Реализовано в этой версии: регистрация и модерация водителей, кошелёк/баланс, поток заказов
(доступные → принят → начат → завершён), система из 9 районов Ашхабада с realtime-счётчиками
заказов/свободных водителей, realtime-события через Socket.IO. Полная модель данных (клиенты, ТС,
сообщения, уведомления, настройки) заложена в схему Prisma — под будущий клиентский API и
расширение бизнес-логики, см. `prisma/schema.prisma`.

## Установка

```bash
cd backend
cp .env.example .env      # заполнить DATABASE_URL и сгенерировать секреты JWT
npm install
npm run prisma:migrate    # создаёт БД/таблицы (запросит имя миграции)
npm run seed               # создаёт первого админа + 9 районов Ашхабада + commission_rate
npm run dev                 # http://localhost:4000
```

Секреты для `.env` (не используйте дефолты из `.env.example` в проде):

```bash
openssl rand -hex 64   # JWT_ACCESS_SECRET
openssl rand -hex 64   # JWT_REFRESH_SECRET
```

## Модель ролей и логин

Все роли (`CLIENT`, `DRIVER`, `ADMIN`) — это одна таблица `users` с полем `role`, у водителя и
админа есть таблицы-расширения профиля (`drivers`, `admins`), связанные 1:1 через `user_id`.
Логин один и тот же эндпоинт для всех ролей — какие данные/токен вернутся, определяется ролью
записи в `users`.

Публичная саморегистрация (`POST /auth/register`) доступна **только для водителей**. Админ
создаётся сидом (`npm run seed`) — это осознанное решение: раздача прав администратора не должна
идти через публичный API.

### Жизненный цикл водителя

```
register → Driver.status = PENDING
  ├─ admin approve → APPROVED → может логиниться и работать
  └─ admin block    → BLOCKED  → логин запрещён, активные сокеты принудительно отключаются
```

Проверка статуса происходит заново на **каждый** запрос (`requireApprovedDriver`), а не только при
логине — иначе блокировка админом не подействовала бы, пока не истечёт уже выданный access-токен.

## REST API

Базовый URL: `http://localhost:4000`. Ошибки — JSON `{ message, details? }` с соответствующим HTTP-статусом.

### Auth

| Метод | Путь | Тело | Описание |
|---|---|---|---|
| POST | `/auth/register` | `{ phone, fullName, password }` | Регистрация водителя, статус `PENDING` |
| POST | `/auth/login` | `{ phone, password }` | Логин любой роли → `{ accessToken, refreshToken, user }` |
| POST | `/auth/refresh` | `{ refreshToken }` | Ротация токенов |
| POST | `/auth/logout` | `{ refreshToken }` | Отзыв refresh-токена |

Если водитель со статусом `PENDING` пытается войти — `403` с сообщением
`"Ваш аккаунт ожидает подтверждения"`. Если `BLOCKED` — `403 "Ваш аккаунт заблокирован"`.

Access-токен передаётся в `Authorization: Bearer <accessToken>` на все защищённые роуты ниже.

### Driver (роль DRIVER, статус APPROVED)

| Метод | Путь | Тело | Описание |
|---|---|---|---|
| GET | `/driver/profile` | — | Профиль, район, текущее ТС |
| GET | `/driver/balance` | — | Текущий баланс |
| POST | `/driver/location` | `{ lat, lng, heading?, speed?, accuracy? }` | Обновить позицию (пишет историю + рассылает `driver:location`) |
| POST | `/driver/status` | `{ isOnline?, isAvailable? }` | Переключить онлайн/доступность (доп. эндпоинт, нужен для фичи "онлайн статус") |
| POST | `/driver/vehicle` | `{ plateNumber, make?, model?, color? }` | Указать/обновить номер своей машины (доп. эндпоинт, нужен для экрана "Карта" — CRUD ТС админом ещё не реализован) |
| GET | `/driver/messages?page=&limit=` | — | Своя переписка с админами (обе стороны + broadcast-сообщения) |
| POST | `/driver/messages` | `{ body }` | Написать в поддержку (Чат Админ ↔ водитель, часть 2 — попадает любому подключённому админу) |

### Orders (роль DRIVER, статус APPROVED)

Статусы: `NEW → ACCEPTED → WAITING → STARTED → COMPLETED` (или `CANCELLED` из `ACCEPTED`/`WAITING`).

| Метод | Путь | Тело | Описание |
|---|---|---|---|
| GET | `/orders/available` | — | Свободные заказы своего района (`status=NEW`, без телефона клиента — см. ниже) |
| GET | `/orders/current` | — | Текущий активный заказ водителя (`ACCEPTED`/`WAITING`/`STARTED`) или `null` |
| POST | `/orders/accept` | `{ orderId, etaMinutes }` | `etaMinutes` ∈ `{5,10,15,20}` — «принять через X минут»; атомарно, `409` если уже занят |
| POST | `/orders/waiting` | `{ orderId }` | «Ожидаю» — `ACCEPTED → WAITING`, начинает отсчёт ожидания в точке А |
| POST | `/orders/start` | `{ orderId }` | «Начать поездку» — `WAITING → STARTED`, фиксирует плату за ожидание, включает тариф за км |
| POST | `/orders/complete` | `{ orderId }` | «Завершить заказ» — `STARTED → COMPLETED`, списывает итог с баланса водителя |
| POST | `/orders/cancel` | `{ orderId, reason? }` | Отмена из `ACCEPTED`/`WAITING` (неявка клиента и т.п.) |

Тариф (жёстко задан в `orders.service.js`): первые 3 минуты ожидания в точке А бесплатно, дальше
+1 манат за каждые полные 1.3 минуты; поездка — 1 км = 1.2 маната, километраж считается по тем же
GPS-точкам, что шлёт `POST /driver/location` (сумма расстояний между соседними точками в окне
`startedAt…completedAt`). Итоговая сумма **списывается** с баланса водителя при завершении (не
начисляется — считается, что деньги за поездку водитель уже получил наличными от пассажира, а
это списание — комиссия платформы за диспетчеризацию; см. `transactions.type = PAYMENT`).
Списание уводит баланс в минус, если поездка дороже остатка — заказ всё равно завершается.

Телефон клиента (`clientPhone`) не отдаётся в `GET /orders/available` — только после того, как
заказ реально принят (в ответе `POST /orders/accept` и во всех дальнейших событиях по этому заказу).

### Admin (роль ADMIN)

| Метод | Путь | Тело | Описание |
|---|---|---|---|
| GET | `/admin/drivers?status=&page=&limit=` | — | Список водителей (с балансом, GPS, онлайн-статусом) |
| GET | `/admin/drivers/:id` | — | Один водитель целиком (не зависит от того, загружен ли список — прямая ссылка/обновление страницы должны работать) |
| POST | `/admin/drivers/:id/approve` | — | Одобрить |
| POST | `/admin/drivers/:id/block` | `{ reason? }` | Заблокировать (+ форс-дисконнект сокетов) |
| POST | `/admin/drivers/:id/unblock` | — | Разблокировать |
| POST | `/admin/drivers/:id/balance` | `{ amount, type?, note? }` | Изменить баланс (amount может быть отрицательным) |
| GET | `/admin/drivers/:id/history?page=&limit=` | — | История транзакций и заказов водителя |
| POST | `/admin/messages` | `{ driverId? , broadcast?, title?, body }` | Сообщение водителю или всем водителям (Чат Админ ↔ водитель, часть 1) |
| GET | `/admin/drivers/:id/messages?page=&limit=` | — | Вся переписка с этим водителем в обе стороны, по возрастанию времени |
| POST | `/admin/orders` | `{ pickupLat, pickupLng, pickupAddress?, dropoffLat?, dropoffLng?, dropoffAddress?, priceEstimated?, clientPhone? }` | Ручная/телефонная диспетчеризация — единственный способ создать заказ, пока нет клиентского приложения. Район вычисляется по ближайшему центру к точке А, заказ транслируется водителям в этом районе (`order:new`) |
| GET | `/admin/orders?status=active\|completed\|cancelled\|all&page=&limit=` | — | Все заказы системы, с водителем и районом |

### Districts (любая роль — DRIVER или ADMIN)

| Метод | Путь | Тело | Описание |
|---|---|---|---|
| GET | `/districts` | — | 9 районов с live-счётчиками `{ id, name, activeOrders, freeDrivers }` |

`GET /health` — без авторизации, для проверок работоспособности/оркестратора.

## Система районов

Официально Ашхабад делится на 4 этрапа (Bagtyýarlyk, Berkararlyk, Köpetdag, Büzmeýin) — не на 9.
9 районов здесь — это **операционные диспетчерские зоны**, а не официальные административные
границы: каждый район — точка-центр (`districts.centerLat/centerLng`), а текущий район водителя —
не фиксированное назначение, а результат live-поиска ближайшего центра к его последней GPS-точке
(haversine, см. `src/utils/geo.js`). При каждом `POST /driver/location`, если ближайший район
изменился, `Driver.districtId` обновляется автоматически и уходит broadcast `districts:stats` —
поэтому карточки районов отражают, где водители находятся **прямо сейчас**, а не где их в последний
раз вручную расставил админ. Названия районов реальные (Ашхабад/Ахалский велаят), координаты
центров — приблизительные, безопасно донастраивать через таблицу `districts` без изменения кода.

`activeOrders` — заказы района не в статусе `COMPLETED`/`CANCELLED`. `freeDrivers` — водители со
статусом `APPROVED`, `isOnline`, `isAvailable` **и положительным балансом** (водитель с нулевым
балансом не может брать заказы, поэтому не считается "свободным").

## WebSocket (Socket.IO)

Подключение с JWT access-токеном:

```js
import { io } from 'socket.io-client'
const socket = io('http://localhost:4000', { auth: { token: accessToken } })
```

Соединение без валидного токена или с ролью `CLIENT` (пока не реализовано на клиенте) отклоняется.

Комнаты: `admins`, `drivers` (все водители), `driver:{id}`, `district:{id}`, `districts:overview`
(все сокеты — карточки районов), `order:{id}`.

| Событие (сервер → клиент) | Кому | Payload | Когда |
|---|---|---|---|
| `driver:status` | `admins`, `district:{id}` | `{ driverId, isOnline, isAvailable }` | подключение/отключение сокета, `POST /driver/status` |
| `driver:location` | `admins`, `driver:{id}`, `district:{id}` | `{ driverId, lat, lng, heading, speed, recordedAt }` | `POST /driver/location`. Always reaches the driver's own room too — их собственный экран "Карта" не должен зависеть от баланса/района. |
| `districts:stats` | `districts:overview` | `[{ id, name, activeOrders, freeDrivers }, ...]` (все 9) | смена района водителем, онлайн/баланс/статус заказа — см. «Система районов» |
| `order:new` | `district:{id}`, `admins` | полный заказ (без `clientPhone`, см. выше) | `POST /admin/orders` — «Новый заказ» водителю |
| `order:accepted` / `order:waiting` / `order:started` / `order:completed` / `order:cancelled` | `admins`, `order:{id}` | полный заказ | соответствующий REST-вызов водителя |
| `order:taken` | `district:{id}` | `{ orderId }` | заказ принят другим водителем — закрыть попап «Новый заказ» у остальных |
| `balance:updated` | `driver:{id}`, `admins` | `{ driverId, amount, reason, note? }` | завершение заказа или ручная корректировка админом — админ-панель видит баланс живым, без рефетча |
| `driver:approved` / `driver:blocked` | `driver:{id}` | `{ driverId, reason? }` | решение админа |
| `admin:message` | `driver:{id}` и `admins`, или `drivers` при broadcast | `{ id, driverId?, title?, body, sentAt, broadcast }` | `POST /admin/messages` или событие `admin:message` от админ-сокета — Чат Админ ↔ водитель, реплика админа |
| `driver:message` | `admins` | `{ id, driverId, body, sentAt }` | `POST /driver/messages` или событие `driver:message` от сокета водителя — Чат Админ ↔ водитель, реплика водителя |

Онлайн-статус определяется по наличию открытых сокетов у водителя (с 5-секундной защитой от
"дребезга" при разрыве/восстановлении соединения), а не только явным вызовом `POST /driver/status`.

**Важно для масштабирования:** presence и `io.to(room).emit(...)` сейчас работают в памяти одного
процесса. При горизонтальном масштабировании (несколько инстансов Node) нужно подключить
`@socket.io/redis-adapter` и вынести карту presence в Redis — в текущей однопроцессной
конфигурации это не требуется.

## Что дальше по плану миграции

Это часть 2 плана (замена Firebase) — далее: `PATCH /admin/drivers/:id` (профиль/ТС), эндпоинты
клиента (`orders` create, полноценная таблица `messages`/`notifications` в API), фронтенд Vue
переводится на этот API вместо `firebase.js`/`vuefire`/`geofire` (см. Этап 4 плана миграции).
