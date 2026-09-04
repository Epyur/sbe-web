import { API_BASE } from '../config';
import { apiRequest, assertOk, requestJSON } from './http';
import { getToken } from './authApi';
import { viewAsHeader } from '../store/viewAs';
import type {
  AuditLogEntry, Lab, LabGroup, LabMethod, LabObject, LabProject, LabRequest,
  MyPermission, ProtocolResponse, UploadFileResponse,
} from '../types/requests';

const APP_ID = 'lab';

async function authHeader(): Promise<Record<string, string>> {
  const token = await getToken(APP_ID);
  return { Authorization: `Bearer ${token}`, ...viewAsHeader('lab') };
}

async function jsonHeaders(): Promise<Record<string, string>> {
  return { ...(await authHeader()), 'Content-Type': 'application/json' };
}

export async function getMyPermission(): Promise<MyPermission> {
  return requestJSON(`${API_BASE}/api/lab/permissions/me`, { headers: await authHeader() });
}

export async function listRequests(): Promise<LabRequest[]> {
  const data = await requestJSON<{ requests?: LabRequest[] }>(`${API_BASE}/api/lab/requests`, {
    headers: await authHeader(),
  });
  return data.requests ?? [];
}

export async function getRequest(id: number): Promise<LabRequest> {
  const data = await requestJSON<{ request: LabRequest }>(`${API_BASE}/api/lab/requests/${id}`, {
    headers: await authHeader(),
  });
  return data.request;
}

export interface CreateRequestInput {
  title: string;
  description: string;
  object_id: number;
  project_id: number;
  group_id: number;
  priority: string;
  test_purpose: string;
  ekn: string;
  external_id: string;
  methods: Array<{ method_id: number; lab_id: number }>;
}

export async function createRequest(input: CreateRequestInput): Promise<LabRequest[]> {
  const data = await requestJSON<{ requests: LabRequest[] }>(`${API_BASE}/api/lab/requests`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify(input),
  });
  return data.requests;
}

export type UpdateRequestInput = Partial<{
  title: string; description: string; object_id: number; project_id: number; group_id: number;
  priority: string; test_purpose: string; ekn: string; external_id: string;
}>;

export async function updateRequest(id: number, input: UpdateRequestInput): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/lab/requests/${id}`, {
    method: 'PATCH',
    headers: await jsonHeaders(),
    body: JSON.stringify(input),
  });
  await assertOk(res);
}

export async function setRequestStatus(id: number, status: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/lab/requests/${id}/status`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ status }),
  });
  await assertOk(res);
}

/** Заполнить недостающий целевой показатель заявки (только когда его нет —
 * сервер вернёт 409, если он уже задан). Успешный вызов также запускает
 * серверный пересчёт классификации/соответствия — после него нужно заново
 * запросить заявку (getRequest), это тело ответа не несёт. */
export async function setTargetIndicator(requestId: number, indicator: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/lab/requests/${requestId}/target-indicator`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ indicator }),
  });
  await assertOk(res);
}

export async function listProjects(): Promise<LabProject[]> {
  const data = await requestJSON<{ projects?: LabProject[] }>(`${API_BASE}/api/lab/projects`, {
    headers: await authHeader(),
  });
  return data.projects ?? [];
}

export async function createProject(input: {
  parent_id: number; code: string; name: string; description: string; is_ekn: boolean; group_id: number;
  mail_trigger_ekn: string; mail_trigger_sender: string;
}): Promise<number> {
  const data = await requestJSON<{ id?: number }>(`${API_BASE}/api/lab/projects`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify(input),
  });
  return data.id ?? 0;
}

export async function updateProject(
  id: number,
  input: Partial<{
    code: string; name: string; description: string; group_id: number; parent_id: number;
    mail_trigger_ekn: string; mail_trigger_sender: string;
  }>,
): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/lab/projects/${id}`, {
    method: 'PATCH',
    headers: await jsonHeaders(),
    body: JSON.stringify(input),
  });
  await assertOk(res);
}

export async function deleteProject(id: number): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/lab/projects/${id}`, {
    method: 'DELETE',
    headers: await authHeader(),
  });
  await assertOk(res);
}

export async function listObjects(): Promise<LabObject[]> {
  const data = await requestJSON<{ objects?: LabObject[] }>(`${API_BASE}/api/lab/objects`, {
    headers: await authHeader(),
  });
  return data.objects ?? [];
}

export async function createObject(
  name: string, description: string, characteristics: Record<string, unknown>,
): Promise<number> {
  const data = await requestJSON<{ id?: number }>(`${API_BASE}/api/lab/objects`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ name, description, characteristics }),
  });
  return data.id ?? 0;
}

export async function updateObject(
  id: number,
  input: Partial<{ name: string; description: string; characteristics: Record<string, unknown> }>,
): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/lab/objects/${id}`, {
    method: 'PATCH',
    headers: await jsonHeaders(),
    body: JSON.stringify(input),
  });
  await assertOk(res);
}

export async function listLabs(): Promise<Lab[]> {
  const data = await requestJSON<{ labs?: Lab[] }>(`${API_BASE}/api/lab/labs`, { headers: await authHeader() });
  return data.labs ?? [];
}

export async function listMethods(): Promise<LabMethod[]> {
  const data = await requestJSON<{ methods?: LabMethod[] }>(`${API_BASE}/api/lab/methods`, {
    headers: await authHeader(),
  });
  return data.methods ?? [];
}

export async function listGroups(): Promise<LabGroup[]> {
  const data = await requestJSON<{ groups?: LabGroup[] }>(`${API_BASE}/api/lab/groups`, {
    headers: await authHeader(),
  });
  return data.groups ?? [];
}

export async function createGroup(name: string): Promise<number> {
  const data = await requestJSON<{ id?: number }>(`${API_BASE}/api/lab/groups`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ name }),
  });
  return data.id ?? 0;
}

export async function addGroupMember(groupId: number, email: string, role: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/lab/groups/${groupId}/members`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ email, role }),
  });
  await assertOk(res);
}

export async function removeGroupMember(groupId: number, email: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/lab/groups/${groupId}/members/${encodeURIComponent(email)}`, {
    method: 'DELETE',
    headers: await authHeader(),
  });
  await assertOk(res);
}

export async function deleteGroup(id: number): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/lab/groups/${id}`, {
    method: 'DELETE',
    headers: await authHeader(),
  });
  await assertOk(res);
}

export async function listAuditLog(requestId: number): Promise<AuditLogEntry[]> {
  const data = await requestJSON<{ entries?: AuditLogEntry[] }>(
    `${API_BASE}/api/lab/requests/${requestId}/audit-log`,
    { headers: await authHeader() },
  );
  return data.entries ?? [];
}

export async function getProtocolHTML(requestId: number): Promise<string> {
  const res = await apiRequest(`${API_BASE}/api/lab/requests/${requestId}/protocol?template=ui&format=html`, {
    method: 'POST',
    headers: await authHeader(),
  });
  await assertOk(res);
  const data = (await res.json()) as ProtocolResponse;
  return data.html;
}

export async function getProtocolExcerptHTML(requestId: number): Promise<string> {
  const res = await apiRequest(`${API_BASE}/api/lab/requests/${requestId}/protocol?template=excerpt&format=html`, {
    method: 'POST',
    headers: await authHeader(),
  });
  await assertOk(res);
  const data = (await res.json()) as ProtocolResponse;
  return data.html;
}

/** «Справка» — отдельный, специально настраиваемый администратором вид
 * шаблона протокола (не путать с «Выписка» / template=excerpt выше). Именно
 * им теперь наполняется hover-подсказка над «Не соответствует» в RequestsView.vue. */
export async function getProtocolHelpHTML(requestId: number): Promise<string> {
  const res = await apiRequest(`${API_BASE}/api/lab/requests/${requestId}/protocol?template=help&format=html`, {
    method: 'POST',
    headers: await authHeader(),
  });
  await assertOk(res);
  const data = (await res.json()) as ProtocolResponse;
  return data.html;
}

export async function getProtocolDocxBase64(requestId: number): Promise<string> {
  const res = await apiRequest(`${API_BASE}/api/lab/requests/${requestId}/protocol?template=protocol&format=full`, {
    method: 'POST',
    headers: await authHeader(),
  });
  await assertOk(res);
  const data = (await res.json()) as ProtocolResponse;
  return data.docx_base64;
}

export async function getExportXlsxBase64(requestId: number): Promise<string> {
  const res = await apiRequest(`${API_BASE}/api/lab/requests/${requestId}/export.xlsx`, {
    headers: await authHeader(),
  });
  await assertOk(res);
  const data = (await res.json()) as { xlsx_base64: string };
  return data.xlsx_base64;
}

export async function downloadFileBlobUrl(fileKey: string): Promise<string> {
  const res = await apiRequest(`${API_BASE}/api/lab/file?key=${encodeURIComponent(fileKey)}`, {
    headers: await authHeader(),
    timeoutMs: 120000,
  });
  await assertOk(res);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function uploadFile(file: File, requestId: number): Promise<UploadFileResponse> {
  const form = new FormData();
  form.set('request_id', String(requestId));
  form.set('file', file, file.name);
  const res = await apiRequest(`${API_BASE}/api/lab/file`, {
    method: 'POST',
    headers: await authHeader(),
    body: form,
    timeoutMs: 120000,
  });
  await assertOk(res);
  return (await res.json()) as UploadFileResponse;
}

export async function listPermissions(): Promise<Array<{ email: string; role: string }>> {
  const data = await requestJSON<{ permissions?: Array<{ email: string; role: string }> }>(
    `${API_BASE}/api/lab/permissions`,
    { headers: await authHeader() },
  );
  return data.permissions ?? [];
}

export async function setPermission(email: string, role: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/lab/permissions`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ email, role }),
  });
  await assertOk(res);
}

export async function getCommonAccess(): Promise<string> {
  const data = await requestJSON<{ level?: string }>(`${API_BASE}/api/lab/common-access`, {
    headers: await authHeader(),
  });
  return data.level ?? '';
}

export async function setCommonAccess(level: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/lab/common-access`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify({ level }),
  });
  await assertOk(res);
}
