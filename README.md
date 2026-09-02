# ЦУП Веб

Веб-портал SBE: браузерный доступ (без Obsidian) к Фотобанку (просмотр/поиск)
и Заявкам на испытания (admin-уровень, без superadmin). Vue 3 + Vite + TypeScript.

Автор: Полищук Евгений (polishchuk@tn.ru).

Прод: <https://epyur.fvds.ru/app/>.

## Разработка

```
npm install
npm run dev
```

Для локальной разработки против продового API создать `.env.local`:

```
VITE_API_BASE=https://epyur.fvds.ru
```

(в проде портал и API — один домен, `VITE_API_BASE` не нужен).

## Сборка и деплой

```
npm run build
```

`dist/` копируется на сервер в `/opt/mailers/www/app/` (Caddy отдаёт статику по
`/app/*`, см. `sbe-core/docker/AGENTS.md`). Деплой — вручную (`scp`), без CI.

См. `AGENTS.md` и `specification.md` для архитектуры и API.
