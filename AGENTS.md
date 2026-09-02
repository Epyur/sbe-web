# AGENTS.md — sbe-web («ЦУП Веб»)

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
