/** Базовый URL API. Пусто — тот же домен, что и портал (прод: /app/ и /auth/, /api/
 * на одном origin, CORS не нужен). Для локальной разработки (`npm run dev`) задаётся
 * `VITE_API_BASE=https://epyur.fvds.ru` в `.env.local` — сервер уже разрешает CORS
 * с любого origin (withCORS в auth-service/photo-service/lab-service). */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');
