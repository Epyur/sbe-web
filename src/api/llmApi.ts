import { API_BASE } from '../config';
import { requestJSON, apiRequest, assertOk, AbortedByUserError } from './http';
import { getToken } from './authApi';
import type { LlmModel } from '../types/agent';

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

// ================= Модели и завершение диалога (для agent-модуля) =================

/** Список моделей провайдера (цены + is_old_model), ключом текущего пользователя —
 * порт SbeLlmApi.listModels() (sbe-llm/src/services/llm-center.ts), для дропдауна модели. */
export async function listModels(): Promise<LlmModel[]> {
  const data = await requestJSON<{ data?: LlmModel[] }>(`${API_BASE}/api/llm/models`, {
    headers: await authHeader(),
  });
  return Array.isArray(data.data) ? data.data : [];
}

interface LLMResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

// Порт SbeLlmApi.retryWithBackoff — троттлинг между запросами + ретраи на
// 429/504 с экспоненциальной задержкой. Без этого прод показал реальный сбой:
// таймаут по умолчанию (30с) слишком короткий для LLM-ответа с большим
// транскриптом/списком тулов — сервер отвечает, но дольше 30с.
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 2000;

/** Сон, который завершается досрочно (реджектом AbortedByUserError), если
 * signal отменяется во время ожидания — иначе Esc пришлось бы ждать полную
 * задержку между ретраями (до нескольких секунд) прежде чем агент остановится. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortedByUserError());
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(new AbortedByUserError()); };
    const cleanup = () => { window.clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort);
  });
}

async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 3000, signal?: AbortSignal): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) throw new AbortedByUserError();
    try {
      const now = Date.now();
      const sinceLast = now - lastRequestTime;
      if (sinceLast < MIN_REQUEST_INTERVAL_MS) {
        await abortableSleep(MIN_REQUEST_INTERVAL_MS - sinceLast, signal);
      }
      lastRequestTime = Date.now();
      return await fn();
    } catch (e: unknown) {
      if (e instanceof AbortedByUserError) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
      const err = e as { message?: string; status?: number };
      // status===0 — сетевая ошибка/наш собственный таймаут (см. apiRequest в http.ts,
      // бросает ApiError(0, 'Сервер не ответил: ...') на AbortSignal.timeout).
      const retryable = err.status === 429 || err.status === 504 || err.status === 0
        || (typeof err.message === 'string' && (/(^|\s)(429|504)(\s|:|$)/.test(err.message) || err.message.startsWith('Timeout:')));
      if (retryable) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`[sbe-web LLM] попытка ${attempt + 1} вернула ${err.message}, повтор через ${delay}ms...`);
        await abortableSleep(delay, signal);
        continue;
      }
      throw e;
    }
  }
  throw lastError || new Error('Превышено количество попыток');
}

/** Порт SbeLlmApi.chatCompletion — тело запроса в формате провайдера
 * ({model?, messages, temperature}), llm-service пересылает его как есть.
 * Таймаут 180с (не дефолтные 30с) — как в Obsidian-версии, LLM-ответ с
 * большим транскриптом/списком тулов может идти дольше 30 секунд. */
async function chatCompletion(payload: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  return retryWithBackoff(async () => {
    const data = await requestJSON<LLMResponse>(`${API_BASE}/api/llm/chat/completions`, {
      method: 'POST',
      headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 180000,
      signal,
    });
    return data.choices?.[0]?.message?.content || '';
  }, 3, 3000, signal);
}

/** Порт SbeLlmApi.complete — используется циклом агента (modules/agent/agentEngine.ts).
 * signal — отмена всего запроса (включая ретраи/паузу между ними) при остановке
 * агента пользователем (Esc/кнопка «Стоп»), см. AbortedByUserError в http.ts. */
export async function complete(
  system: string,
  user: string,
  opts?: { model?: string; temperature?: number },
  signal?: AbortSignal,
): Promise<string> {
  const model = opts?.model?.trim() || '';
  return chatCompletion({
    ...(model ? { model } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: opts?.temperature ?? 0.4,
  }, signal);
}

function extractJsonBlock(text: string): unknown {
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('JSON не найден в ответе LLM');
  return JSON.parse(cleaned.substring(start, end + 1));
}

/** Порт SbeLlmApi.completeJson — не используется циклом агента напрямую (тот
 * разбирает ответ сам, лениво, см. agentEngine.ts parseTurns), оставлен на будущее. */
export async function completeJson<T>(
  system: string,
  user: string,
  opts?: { model?: string; temperature?: number },
): Promise<T> {
  const text = await complete(system, user, opts);
  try {
    return extractJsonBlock(text) as T;
  } catch {
    const retry = await complete(system, 'Предыдущий ответ не был валидным JSON. Верни ТОЛЬКО JSON по той же схеме.', opts);
    return extractJsonBlock(retry) as T;
  }
}
