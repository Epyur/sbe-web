import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Портал раздаётся Caddy по пути /app/ (см. Фаза 5 плана) — base нужен,
  // чтобы собранные ассеты ссылались на /app/assets/..., а не на корень домена.
  base: '/app/',
  plugins: [vue()],
})
