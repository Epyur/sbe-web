import { reactive, readonly } from 'vue';

/** «Просмотр от лица роли» (2026-09-03) — доступно только реальному
 * superadmin: сервер (lab-service/photo-service) валидирует запрошенную роль
 * против настоящей на каждый запрос и ограничивает ВСЁ (видимость данных,
 * права на действия), а не только вёрстку — см. X-View-As-Role в
 * jwt.go:effectiveRole обоих сервисов. Сознательно не персистится
 * (localStorage) — сбрасывается при каждой перезагрузке страницы, чтобы
 * суперадмин не забыл, что режим включён.
 */
export type ViewAsApp = 'photo' | 'lab';

const state = reactive<Record<ViewAsApp, string>>({ photo: '', lab: '' });

export const viewAsState = readonly(state);

export function setViewAsRole(app: ViewAsApp, role: string): void {
  state[app] = role;
}

export function viewAsHeader(app: ViewAsApp): Record<string, string> {
  return state[app] ? { 'X-View-As-Role': state[app] } : {};
}
