# AGENTS.md — sbe-web («LogicTEAM.WWW»)

Веб-портал SBE — единственный клиент в проекте, который не является Obsidian-плагином
(нет `manifest.json`, никогда не грузится в Obsidian). По аналогии с `mobile/`
(мобильные плагины живут вне `.obsidian/plugins`) — исходники в
`C:\Obsidian\mailers\web\sbe-web\`, собранный `dist/` копируется на сервер вручную
(`scp`), без CI. Design: `docs/superpowers/specs/2026-09-02-sbe-web-portal-design.md`
(в репозитории `sbe-core`).

## Назначение

- **Вход** — magic-link: email → письмо со ссылкой (5 мин, одноразовая) →
  `POST /auth/web/consume` → `{key, device_id}` в `localStorage` (бессрочно, как у
  Obsidian-плагина, до ручного отзыва через `/auth/devices`). Дальше — обычный
  `POST /auth/token {key, app_id}` (то же самое, что `sbe-apstore.auth.getToken`
  для плагинов).
- **Фотобанк** (`/photobank`) — только просмотр/поиск/соцслой (лайк, избранное,
  комментарии, скачивание оригинала). Загрузка/редактирование/управление папками —
  только через Obsidian-плагин: сервер блокирует запись для JWT с `channel=web`
  независимо от роли (см. `sbe-photobank/photo-service/AGENTS.md`).
- **Заявки на испытания** (`/requests`) — зеркало admin-уровня плагина
  `sbe-requests`: заявки, проекты (+ триггеры почты, смена родителя), группы,
  права доступа. `superadmin` недостижим через веб ни при каких обстоятельствах —
  сервер клэмпит эффективную роль `superadmin → admin` для `channel=web`
  (см. `sbe-lims/lab-service/AGENTS.md`).

## Структура

| Путь | Что это |
|---|---|
| `src/api/http.ts` | Общий fetch-слой: таймаут, `ApiError`, единая обработка 401/403 |
| `src/api/authApi.ts` | `requestLink`/`consumeLink`/`getToken` (кэш JWT в памяти на `app_id`) |
| `src/api/photoApi.ts` | Клиент photo-service (только используемые read+social эндпоинты) |
| `src/api/labApi.ts` | Клиент lab-service (requests/projects/objects/groups/permissions/files/protocol) |
| `src/store/session.ts` | Сессия (`{key, device_id, email}`) в `localStorage`, реактивное состояние |
| `src/router.ts` | Hash-роутинг (`createWebHashHistory`) — magic-link `#/verify?token=...` |
| `src/views/` | `LoginView`/`VerifyView`/`LauncherView` |
| `src/modules/photobank/` | `PhotobankView` + `FolderTree`/`PhotoThumb`/`PhotoDetailModal` |
| `src/modules/requests/` | `RequestsView` + `ProjectTree`/`ProjectsPanel`/`RequestDetail`/`RequestCreateModal`/`GroupsPanel`/`PermissionsPanel` |

## Правила

- Обычный `fetch()` — не `requestUrl()` (это Obsidian API, здесь не нужен и недоступен).
- `catch` — по возможности `unknown` + `errorMessage()` (см. `src/api/http.ts`), без `any`.
- UI на русском; автор — Полищук Евгений (polishchuk@tn.ru).
- Классы `sw-*` на CSS-переменных (`src/style.css`) — свой набор токенов, не
  завязан на `sbe-core` (это не Obsidian-плагин).
- `vite.config.ts`: `base: '/app/'` — обязателен, иначе собранные ассеты будут
  ссылаться на корень домена вместо `/app/`.
- Коммиты/пуши — только по явной команде пользователя («Фиксируй»).

## История работ

### 2026-09-03 — форма заявки в полное соответствие с Obsidian-плагином + просмотр от лица роли
- **Форма создания заявки** (`RequestCreateModal.vue`) переписана под структуру
  Obsidian-плагина sbe-requests (по прямой жалобе пользователя — не хватало
  ЕКН и ряда полей, метод выбирался по названию без показателя):
  - **ЕКН**: автопоиск (подсказки по мере ввода) + точный лукап по 6-значному
    номеру, автозаполнение названия/толщины — новый клиент `api/eknApi.ts`
    (`GET /api/ekn/search`, `GET /api/ekn/product/{ekn}`, `POST
    /api/ekn/manual/{ekn}`, JWT `app_id=ekn`, уже был в белом списке
    реестра — доп. настройка не понадобилась).
  - Номер партии (обязателен при ЕКН), поля экспериментального образца
    (название/тип/толщина/идентификатор).
  - **«Целевой показатель»** — обязательный выбор на каждый выбранный метод с
    непустым `determinable_indicators` (один ГОСТ может оценивать разные
    показатели — без явного выбора неясно, что именно измерялось).
    Автоподстановка из групп пожарной классификации ЕКН
    (`readFireGroupValue`, та же логика, что в Obsidian).
  - Методы показываются как «код — название», сгруппированы по лаборатории.
  - «Название заявки» как ручное поле убрано — как и в Obsidian, title
    автоматически берётся из названия материала/продукта.
  - Строка поиска в селекторах Проект/Группа/Объект (существующий) —
    при большом справочнике обычный `<select>` становится нефункциональным.
- **«Просмотр от лица роли»** — новый общий стор `store/viewAs.ts` +
  компонент `components/ViewAsRoleSwitcher.vue`, подключены в
  `PhotobankView.vue`/`RequestsView.vue`; заголовок `X-View-As-Role`
  добавлен в `authHeader()` `photoApi.ts`/`labApi.ts`. Не персистится
  (сбрасывается при перезагрузке страницы, по решению пользователя).
  Серверная часть (реальное ограничение видимости/прав, не только UI) —
  см. `sbe-lims/lab-service/AGENTS.md` и `sbe-photobank/photo-service/AGENTS.md`.
- **QR-этикетки** (`RequestDetail.vue`, новый `modules/requests/qrPrint.ts`):
  печать одной этикетки теперь показывает номер заявки и название под QR
  (было — голый QR без подписи); добавлена пакетная печать в списке заявок
  (чекбоксы + «Печать листа QR (N)») — копия механики из Obsidian-плагина.
- Кнопка текущего статуса заявки подсвечивается зелёным (`RequestDetail.vue`).
- Добавлены поля «Дата создания», «Дедлайн» (создание + 14 календарных
  дней), «Дата завершения» (`completed_at` — был в API, не было в типе
  фронтенда).

### 2026-09-02 — v0.1.0 (создание)

Design → implementation в одну сессию (см. `docs/superpowers/specs/
2026-09-02-sbe-web-portal-design.md` в `sbe-core`). Бэкенд-часть (magic-link в
auth-service, `channel=web` в photo-service/lab-service) — отдельные коммиты в
соответствующих репозиториях, см. их `AGENTS.md`.

- Скаффолд Vite (`vue-ts`), `vue-router@4`, `qrcode` (MIT, для QR-этикеток заявок).
- Auth: login → magic-link → launcher (проверка доступа к `photo`/`lab` через
  пробный `getToken`).
- Фотобанк: дерево папок, сетка, поиск, карточка с лайком/избранным/
  комментариями/скачиванием. **Найден и исправлен баг при разработке**:
  `GET /api/photo/search` с пустым `q` всегда отдаёт `{photos:[]}` (сервер строит
  `andClause`/`orClause` только когда `q` непусто) — для «показать всё»/«показать
  папку» используется `GET /api/photo/sync/pull` (тот же эндпоинт, что и у
  плагина), не `search('')`.
- Заявки: дерево проектов (+ создание/редактирование, включая триггеры почты и
  смену родителя — см. `lab-service/AGENTS.md`), список/карточка заявки,
  создание, файлы, протокол (HTML-просмотр + скачивание Word/Excel), QR-этикетка,
  группы, права доступа (без пункта «Супер-администратор» — сервер и так его не
  даст назначить через веб).
- Деплой: `dist/` → `/opt/mailers/www/app/`, Caddyfile `handle_path /app/*` (см.
  `sbe-core/docker/AGENTS.md`). E2E пройден живьём: вход по реальной почте,
  просмотр 116 фото, создание/редактирование заявок и проектов.
- `npx vue-tsc --noEmit`, `npm run build` — чисто.
