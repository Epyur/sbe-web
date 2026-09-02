import { API_BASE } from '../config';
import { requestJSON } from './http';
import { clearSession, sessionState } from '../store/session';

/** Кэш JWT по app_id в памяти вкладки — не в localStorage (короткоживущие,
 * ~1 час), обновляется заранее до истечения. Зеркало того, как
 * `sbe-apstore.auth.getToken` работает для Obsidian-плагинов. */
const tokenCache = new Map<string, { jwt: string; expiresAt: number }>();
const REFRESH_MARGIN_MS = 60_000;

export async function requestLink(email: string): Promise<void> {
  await requestJSON(`${API_BASE}/auth/web/request-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

export async function consumeLink(token: string): Promise<{ email: string; deviceId: string; key: string }> {
  const data = await requestJSON<{ email: string; device_id: string; key: string }>(
    `${API_BASE}/auth/web/consume`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    },
  );
  return { email: data.email, deviceId: data.device_id, key: data.key };
}

/** JWT для конкретного приложения (photo|lab). 403 — у пользователя нет
 * доступа к этому приложению; 401 — сессия отозвана, сбрасываем её. */
export async function getToken(appId: string): Promise<string> {
  const cached = tokenCache.get(appId);
  if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return cached.jwt;
  }
  const session = sessionState.session;
  if (!session) throw new Error('Не авторизован');
  try {
    const data = await requestJSON<{ jwt: string; expires_at: string }>(`${API_BASE}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: session.key, app_id: appId }),
    });
    tokenCache.set(appId, { jwt: data.jwt, expiresAt: new Date(data.expires_at).getTime() });
    return data.jwt;
  } catch (e) {
    if (e instanceof Error && 'status' in e && (e as { status: number }).status === 401) {
      clearSession();
    }
    throw e;
  }
}

/** Есть ли у пользователя вообще доступ к приложению (для лаунчера) — не
 * бросает исключение при 403, просто возвращает false. */
export async function hasAppAccess(appId: string): Promise<boolean> {
  try {
    await getToken(appId);
    return true;
  } catch {
    return false;
  }
}
