import { API_BASE } from '../config';
import { requestJSON, apiRequest, assertOk } from './http';
import { getToken } from './authApi';

// Настройки подключения к ЮГайлу — 1:1 с llmApi.ts (тот же паттерн хранения
// секрета пользователя на сервере). Логин ЮГайла = email пользователя (тот же,
// что в ЦУП), companyId — константа сервера; в UI задаётся только пароль.

const APP_ID = 'agent';

async function authHeader(): Promise<Record<string, string>> {
  const token = await getToken(APP_ID);
  return { Authorization: `Bearer ${token}` };
}

export interface YougileStatus {
  connected: boolean;
}

/** Пароль никогда не возвращается сервером — только статус подключения. */
export async function getStatus(): Promise<YougileStatus> {
  const data = await requestJSON<{ connected?: boolean }>(`${API_BASE}/api/agent/yougile/settings`, {
    headers: await authHeader(),
  });
  return { connected: !!data.connected };
}

export async function setPassword(password: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/agent/yougile/settings`, {
    method: 'POST',
    headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  await assertOk(res);
}

export async function deletePassword(): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/agent/yougile/settings`, {
    method: 'DELETE',
    headers: await authHeader(),
  });
  await assertOk(res);
}
