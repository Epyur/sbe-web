import { API_BASE } from '../config';
import { apiRequest, assertOk, requestJSON } from './http';
import { getToken } from './authApi';
import type {
  Dialog, AgentRule, GlobalSkillLite, GlobalSkill,
  FileGenerateResponse, FileParseResponse,
} from '../types/agent';

const APP_ID = 'agent';

/** Заголовок авторизации для app_id (по умолчанию — 'agent'). Без X-View-As-Role:
 * агент не участвует в «просмотре от лица роли» (не пишет в чужие сервисы). */
async function authHeader(appId: string = APP_ID): Promise<Record<string, string>> {
  const token = await getToken(appId);
  return { Authorization: `Bearer ${token}` };
}

async function jsonHeaders(appId: string = APP_ID): Promise<Record<string, string>> {
  return { ...(await authHeader(appId)), 'Content-Type': 'application/json' };
}

// ================= Файлы (agent-service) =================

export async function generateFile(format: string, spec: Record<string, unknown>): Promise<FileGenerateResponse> {
  return requestJSON<FileGenerateResponse>(`${API_BASE}/api/agent/file/generate`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ format, spec }),
    timeoutMs: 120000,
  });
}

/** Сохраняет уже отрисованный на клиенте файл (график ApexCharts —
 * modules/agent/chartRenderer.ts, или презентация — presentationRenderer.ts)
 * в S3 — тот же формат ответа, что у generateFile; extWithDot включает точку
 * (например ".png"/".html"), сервер по нему же определяет допустимость. */
export async function storeClientFile(blob: Blob, fileName: string, extWithDot: string): Promise<FileGenerateResponse> {
  const form = new FormData();
  form.set('file', blob, `${fileName}${extWithDot}`);
  form.set('file_name', fileName);
  const res = await apiRequest(`${API_BASE}/api/agent/file/store`, {
    method: 'POST',
    headers: await authHeader(),
    body: form,
    timeoutMs: 60000,
  });
  await assertOk(res);
  return (await res.json()) as FileGenerateResponse;
}

export async function parseFile(file: File): Promise<FileParseResponse> {
  const form = new FormData();
  form.set('file', file, file.name);
  const res = await apiRequest(`${API_BASE}/api/agent/file/parse`, {
    method: 'POST',
    headers: await authHeader(), // без Content-Type — границу multipart проставит браузер
    body: form,
    timeoutMs: 120000,
  });
  await assertOk(res);
  return (await res.json()) as FileParseResponse;
}

// ================= Данные (чужие plugin-services) =================

/** Общий pull из plugin-service, всегда напрямую (в вебе нет локального кэша —
 * ветка «сначала кэш» из Obsidian-плагина здесь не нужна). */
export async function pullSourceItems(appId: string, listKey: string): Promise<Record<string, unknown>[]> {
  const data = await requestJSON<Record<string, unknown>>(`${API_BASE}/api/${appId}/sync/pull`, {
    headers: await authHeader(appId),
    timeoutMs: 120000,
  });
  const items = data[listKey];
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

export async function getMyPermission(appId: string): Promise<{ role: string; hasAccess: boolean }> {
  return requestJSON(`${API_BASE}/api/${appId}/permissions/me`, { headers: await authHeader(appId) });
}

/** Заявки ЛИМС — GET /api/lab/requests (тот же эндпоинт, что и модуль «Заявки на
 * испытания» веба), НЕ /api/lab/sync/pull: у sync/pull минимальный набор полей
 * (для офлайн-кэша Obsidian-плагина), без result/compliance — агент не мог
 * определить вердикт «Не соответствует» по заявке. /api/lab/requests отдаёт
 * полный объект LabRequest (title, result, compliance и т.д.), та же обёртка
 * {requests: [...]}. */
export async function getLimsRequests(): Promise<Record<string, unknown>[]> {
  const data = await requestJSON<Record<string, unknown>>(`${API_BASE}/api/lab/requests`, {
    headers: await authHeader('lab'),
    timeoutMs: 60000,
  });
  return Array.isArray(data.requests) ? (data.requests as Record<string, unknown>[]) : [];
}

/** Generic GET для describe_api/call_api (см. modules/agent/apiManifest.ts) — тот же
 * JWT-механизм по app_id, что и у остальных функций этого файла; путь и параметры
 * приходят уже проверенными против белого списка (вызывающий код в tools.ts). */
export async function callAppApi(
  appId: string,
  path: string,
  query: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== '') url.searchParams.set(key, value);
  }
  return requestJSON<unknown>(url.toString(), { headers: await authHeader(appId), timeoutMs: 60000 });
}

/** Справочник лабораторий — нужен get_lims_requests, чтобы отфильтровать заявки по
 * лаборатории (сам объект заявки несёт только числовой lab_id). */
export async function getLimsLabs(): Promise<Record<string, unknown>[]> {
  const data = await requestJSON<Record<string, unknown>>(`${API_BASE}/api/lab/labs`, {
    headers: await authHeader('lab'),
  });
  return Array.isArray(data.labs) ? (data.labs as Record<string, unknown>[]) : [];
}

export async function getPhotos(): Promise<Record<string, unknown>[]> {
  const data = await requestJSON<Record<string, unknown>>(`${API_BASE}/api/photo/sync/pull`, {
    headers: await authHeader('photo'),
    timeoutMs: 120000,
  });
  return Array.isArray(data.photos) ? (data.photos as Record<string, unknown>[]) : [];
}

export async function getPhotoLink(fileKey: string): Promise<string> {
  const data = await requestJSON<{ url?: string }>(
    `${API_BASE}/api/photo/file-link?key=${encodeURIComponent(fileKey)}`,
    { headers: await authHeader('photo'), timeoutMs: 60000 },
  );
  return data.url || '';
}

// ================= fetch_url (скрытый серверный HTTP через agent-service) =================

export interface FetchUrlResponse {
  status: number;
  content_type: string;
  text: string;
}

export async function fetchUrl(payload: {
  method?: string; url: string; body?: string; headers?: Record<string, string>; timeout_ms?: number;
}): Promise<FetchUrlResponse> {
  return requestJSON<FetchUrlResponse>(`${API_BASE}/api/agent/fetch`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify(payload),
    timeoutMs: 120000,
  });
}

// ================= Глобальные скилы =================

export async function listGlobalSkills(): Promise<GlobalSkillLite[]> {
  const data = await requestJSON<{ skills?: GlobalSkillLite[] }>(`${API_BASE}/api/agent/skills`, {
    headers: await authHeader(),
  });
  return data.skills ?? [];
}

export async function getGlobalSkill(name: string): Promise<GlobalSkill | null> {
  try {
    return await requestJSON<GlobalSkill>(`${API_BASE}/api/agent/skills/${encodeURIComponent(name)}`, {
      headers: await authHeader(),
    });
  } catch {
    return null;
  }
}

// ================= История диалогов =================

export async function getChatHistory(): Promise<Dialog[]> {
  const data = await requestJSON<{ dialogs?: Dialog[] }>(`${API_BASE}/api/agent/history`, {
    headers: await authHeader(),
  });
  return data.dialogs ?? [];
}

export async function saveDialog(dialog: Dialog): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/agent/history`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ dialog }),
  });
  await assertOk(res);
}

export async function deleteDialog(id: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/agent/history/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeader(),
  });
  await assertOk(res);
}

// ================= Правила =================

export async function getRules(): Promise<AgentRule[]> {
  const data = await requestJSON<{ rules?: AgentRule[] }>(`${API_BASE}/api/agent/rules`, {
    headers: await authHeader(),
  });
  return data.rules ?? [];
}

export async function saveRule(path: string, content: string, append = false): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/agent/rules`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ path, content, append }),
  });
  await assertOk(res);
}

export async function deleteRule(path: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/agent/rules?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
    headers: await authHeader(),
  });
  await assertOk(res);
}

// ================= Системный промпт =================

export async function getSystemPrompt(): Promise<string> {
  const data = await requestJSON<{ system_prompt?: string }>(`${API_BASE}/api/agent/settings`, {
    headers: await authHeader(),
  });
  return data.system_prompt ?? '';
}

export async function saveSystemPrompt(text: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/agent/settings`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ system_prompt: text }),
  });
  await assertOk(res);
}

export async function resetSystemPrompt(): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/agent/settings`, {
    method: 'DELETE',
    headers: await authHeader(),
  });
  await assertOk(res);
}

// ================= Скретч-хранилище (замена путей в вольте) =================

export async function saveScratchText(name: string, text: string): Promise<{ key: string; total: number }> {
  return requestJSON(`${API_BASE}/api/agent/scratch/text`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ name, text }),
    timeoutMs: 60000,
  });
}

export interface ScratchTextChunk {
  text: string; start: number; end: number; total: number; done: boolean;
}

export async function readScratchText(key: string, start: number, length?: number): Promise<ScratchTextChunk> {
  const params = new URLSearchParams({ key, start: String(start) });
  if (length) params.set('length', String(length));
  return requestJSON(`${API_BASE}/api/agent/scratch/text?${params.toString()}`, { headers: await authHeader() });
}

export async function saveScratchRecords(
  records: unknown[],
  opts: { key?: string; name?: string; mode?: 'append' | 'overwrite' } = {},
): Promise<{ key: string; added: number; total: number }> {
  return requestJSON(`${API_BASE}/api/agent/scratch/records`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ key: opts.key, name: opts.name, records, mode: opts.mode }),
    timeoutMs: 60000,
  });
}

export async function readScratchRecords(key: string): Promise<{ records: unknown[]; total: number }> {
  return requestJSON(`${API_BASE}/api/agent/scratch/records?key=${encodeURIComponent(key)}`, {
    headers: await authHeader(),
  });
}

// ================= YouGile (agent-service — прокси, без CORS-проблемы браузера) =================
// Пароль YouGile и обмен на ключ — целиком на сервере (agent-service); сюда
// приходят уже готовые данные YouGile. Удаления здесь нет ни одного метода —
// см. docs/superpowers/specs/2026-09-06-web-agent-yougile-design.md.

export async function getYougileTasks(filter: { columnId?: string; assignedTo?: string; mine?: boolean }): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  if (filter.columnId) params.set('columnId', filter.columnId);
  if (filter.assignedTo) params.set('assignedTo', filter.assignedTo);
  if (filter.mine) params.set('mine', '1');
  const qs = params.toString();
  const data = await requestJSON<{ content?: Record<string, unknown>[] }>(
    `${API_BASE}/api/agent/yougile/tasks${qs ? `?${qs}` : ''}`,
    { headers: await authHeader(), timeoutMs: 60000 },
  );
  return Array.isArray(data.content) ? data.content : [];
}

export interface YougileSeriesPoint {
  period: string;
  arrived: number;
  completed: number;
}

export interface YougileExecutorStat {
  user_id: string;
  name: string;
  email: string;
  created: number;
  completed: number;
}

export interface YougileTaskStats {
  series: YougileSeriesPoint[];
  by_executor: YougileExecutorStat[];
  total_touched: number;
}

/** Счёт поступивших/завершённых задач по периодам + разбивка по исполнителям
 * за диапазон дат — считает сервер по уже полученным данным (не сырые
 * карточки в контексте модели), тот же принцип, что и у get_lims_requests
 * group_by. Фикс живой жалобы 2026-09-06 (см. agent-service/yougile_stats.go). */
export async function getYougileTaskStats(dateFrom: string, dateTo: string, groupBy: 'day' | 'week' | 'month'): Promise<YougileTaskStats> {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, group_by: groupBy });
  return requestJSON<YougileTaskStats>(`${API_BASE}/api/agent/yougile/task-stats?${params.toString()}`, {
    headers: await authHeader(), timeoutMs: 60000,
  });
}

export interface YougileBoardTree {
  projects: Record<string, unknown>[];
  boards: Record<string, unknown>[];
  columns: Record<string, unknown>[];
  users: Record<string, unknown>[];
}

/** Справочники проект/доска/колонка/пользователь одним вызовом — для
 * сопоставления имён → id при создании задачи/смене статуса. */
export async function getYougileBoardTree(): Promise<YougileBoardTree> {
  return requestJSON<YougileBoardTree>(`${API_BASE}/api/agent/yougile/board-tree`, {
    headers: await authHeader(), timeoutMs: 60000,
  });
}

export async function createYougileTask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return requestJSON<Record<string, unknown>>(`${API_BASE}/api/agent/yougile/tasks`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function setYougileTaskStatus(taskId: string, columnId: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/agent/yougile/tasks/${encodeURIComponent(taskId)}/status`, {
    method: 'PUT',
    headers: await jsonHeaders(),
    body: JSON.stringify({ columnId }),
  });
  await assertOk(res);
}

/** Сообщение в чат задачи + необязательный файл (встраивается сервером как
 * ссылка/картинка в текст — в API YouGile нет отдельного поля «вложение»). */
export async function addYougileTaskMessage(taskId: string, text: string, file?: File): Promise<void> {
  const form = new FormData();
  form.set('text', text);
  if (file) form.set('file', file, file.name);
  const res = await apiRequest(`${API_BASE}/api/agent/yougile/tasks/${encodeURIComponent(taskId)}/message`, {
    method: 'POST',
    headers: await authHeader(), // без Content-Type — границу multipart проставит браузер
    body: form,
    timeoutMs: 60000,
  });
  await assertOk(res);
}
