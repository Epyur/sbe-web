import { reactive, readonly } from 'vue';

/** Сессия веб-портала: {key, device_id, email}, полученные через magic-link
 * (POST /auth/web/consume). Живёт в localStorage бессрочно — как ключ у
 * Obsidian-плагина, пока не отозван вручную (/auth/devices) или не выйдут
 * из портала явно. Приватно для этого браузера/этой вкладки origin. */
const STORAGE_KEY = 'sbe_web_session';

export interface Session {
  key: string;
  deviceId: string;
  email: string;
}

interface SessionState {
  session: Session | null;
}

function loadSession(): Session | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.key || !parsed.deviceId || !parsed.email) return null;
    return { key: parsed.key, deviceId: parsed.deviceId, email: parsed.email };
  } catch {
    return null;
  }
}

const state = reactive<SessionState>({ session: loadSession() });

export const sessionState = readonly(state);

export function setSession(session: Session): void {
  state.session = session;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // localStorage недоступен (приватный режим и т.п.) — сессия останется
    // только в памяти вкладки, ничего страшнее не произойдёт.
  }
}

export function clearSession(): void {
  state.session = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // см. setSession
  }
}

export function isAuthenticated(): boolean {
  return state.session !== null;
}
