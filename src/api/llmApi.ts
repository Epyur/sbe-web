import { API_BASE } from '../config';
import { requestJSON, apiRequest, assertOk } from './http';
import { getToken } from './authApi';

const APP_ID = 'llm';

async function authHeader(): Promise<Record<string, string>> {
  const token = await getToken(APP_ID);
  return { Authorization: `Bearer ${token}` };
}

export interface LlmStatus {
  configured: boolean;
  apiUrlOverride: boolean;
}

/** Ключ никогда не возвращается сервером — только статус конфигурации. */
export async function getStatus(): Promise<LlmStatus> {
  const data = await requestJSON<{ configured?: boolean; api_url_override?: boolean }>(
    `${API_BASE}/api/llm/settings`,
    { headers: await authHeader() },
  );
  return { configured: !!data.configured, apiUrlOverride: !!data.api_url_override };
}

/** Сохраняет/заменяет ключ ТЕКУЩЕГО пользователя (email берётся сервером из JWT). */
export async function setApiKey(apiKey: string, apiUrl?: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/llm/settings`, {
    method: 'POST',
    headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, api_url: apiUrl || '' }),
  });
  await assertOk(res);
}

export async function deleteApiKey(): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/llm/settings`, {
    method: 'DELETE',
    headers: await authHeader(),
  });
  await assertOk(res);
}
