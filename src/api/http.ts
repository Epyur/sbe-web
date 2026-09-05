/** Общий HTTP-слой портала. Обычный fetch() — это браузер, не Obsidian/Electron,
 * requestUrl() из Obsidian API здесь не нужен и недоступен. */

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    // Защита от "[object Object]": message должен быть строкой, но внешние
    // API (не наши сервисы) иногда отдают неожиданную форму ошибки.
    super(typeof message === 'string' ? message : String(message));
    this.status = status;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: BodyInit;
  timeoutMs?: number;
  /** Внешняя отмена (например, кнопка/Esc «Остановить агента») — независима от
   * внутреннего таймаута ниже, обе причины ведут к одному и тому же abort(). */
  signal?: AbortSignal;
}

/** Брошено, если запрос отменён через opts.signal (не по таймауту) — отличать
 * от обычного "сервер не ответил", чтобы показать пользователю осмысленный
 * текст («Остановлено пользователем»), а не сетевую ошибку. */
export class AbortedByUserError extends Error {
  constructor() {
    super('Остановлено пользователем');
  }
}

/** Низкоуровневый запрос с таймаутом и единой обработкой 401/403. */
export async function apiRequest(url: string, opts: RequestOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  const external = opts.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
  } catch (e: unknown) {
    if (external?.aborted) throw new AbortedByUserError();
    throw new ApiError(0, `Сервер не ответил: ${errorMessage(e)}`);
  } finally {
    window.clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
  return res;
}

/** Достаёт текст ошибки из тела ответа. Наши сервисы отдают {error: "текст"},
 * но upstream-провайдеры (например chadgpt/OpenAI-совместимые через llm-service)
 * отдают вложенный {error: {message: "текст", ...}} — раньше объект-error
 * утекал как есть в конструктор Error и превращался в "[object Object]". */
async function errorText(res: Response): Promise<string> {
  try {
    const data = (await res.clone().json()) as { error?: unknown };
    if (typeof data.error === 'string') return data.error;
    if (data.error && typeof data.error === 'object') {
      const nested = (data.error as { message?: unknown }).message;
      if (typeof nested === 'string') return nested;
    }
    return '';
  } catch {
    return '';
  }
}

export async function assertOk(res: Response): Promise<void> {
  if (res.status === 401) throw new ApiError(401, 'Сессия недействительна. Войдите заново.');
  if (res.status === 403) throw new ApiError(403, (await errorText(res)) || 'Нет прав доступа.');
  if (res.status === 429) throw new ApiError(429, 'Слишком много попыток, попробуйте позже.');
  if (!res.ok) throw new ApiError(res.status, (await errorText(res)) || `Сервер вернул HTTP ${res.status}`);
}

export async function requestJSON<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiRequest(url, opts);
  await assertOk(res);
  return (await res.json()) as T;
}
