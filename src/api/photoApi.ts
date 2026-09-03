import { API_BASE } from '../config';
import { apiRequest, assertOk, requestJSON } from './http';
import { getToken } from './authApi';
import { viewAsHeader } from '../store/viewAs';
import type { MyPermission, PhotoComment, PhotoFolder, PhotoItem, PullResponse } from '../types/photobank';

const APP_ID = 'photo';

async function authHeader(): Promise<Record<string, string>> {
  const token = await getToken(APP_ID);
  return { Authorization: `Bearer ${token}`, ...viewAsHeader('photo') };
}

export async function getMyPermission(): Promise<MyPermission> {
  return requestJSON(`${API_BASE}/api/photo/permissions/me`, { headers: await authHeader() });
}

export async function listFolders(): Promise<PhotoFolder[]> {
  const data = await requestJSON<{ folders?: PhotoFolder[] }>(`${API_BASE}/api/photo/folders`, {
    headers: await authHeader(),
  });
  return data.folders ?? [];
}

export async function search(q: string, folderId?: number): Promise<PhotoItem[]> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (folderId && folderId > 0) params.set('folder_id', String(folderId));
  const data = await requestJSON<PullResponse>(`${API_BASE}/api/photo/search?${params.toString()}`, {
    headers: await authHeader(),
  });
  return data.photos ?? [];
}

/** Полный список видимых фото (без текстового запроса). `GET /api/photo/search`
 * с пустым `q` всегда отдаёт `{photos:[]}` (andClause/orClause строятся только
 * когда q непусто) — сервером это используется только для текстового поиска;
 * плагин Фотобанка для «показать всё» использует `sync/pull`, поэтому веб-портал
 * делает то же самое, а не подставляет пустую строку в search(). */
export async function pullAll(): Promise<PhotoItem[]> {
  const data = await requestJSON<PullResponse>(`${API_BASE}/api/photo/sync/pull`, { headers: await authHeader() });
  return data.photos ?? [];
}

export async function favorites(): Promise<PhotoItem[]> {
  const data = await requestJSON<PullResponse>(`${API_BASE}/api/photo/favorites`, { headers: await authHeader() });
  return data.photos ?? [];
}

export async function recent(): Promise<PhotoItem[]> {
  const data = await requestJSON<PullResponse>(`${API_BASE}/api/photo/recent`, { headers: await authHeader() });
  return data.photos ?? [];
}

export async function getPhoto(id: number): Promise<PhotoItem> {
  return requestJSON(`${API_BASE}/api/photo/photos/${id}`, { headers: await authHeader() });
}

export async function viewPhoto(id: number): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/photo/photos/${id}/view`, {
    method: 'POST',
    headers: await authHeader(),
  });
  await assertOk(res);
}

/** Скачивает файл (оригинал или превью) и возвращает blob-URL — `<img src>`/скачивание
 * не могут сами приложить заголовок Authorization, поэтому грузим через fetch. */
export async function fetchFileBlobUrl(fileKey: string, view: boolean): Promise<string> {
  const qs = view ? `?key=${encodeURIComponent(fileKey)}&view=1` : `?key=${encodeURIComponent(fileKey)}`;
  const res = await apiRequest(`${API_BASE}/api/photo/file${qs}`, {
    headers: await authHeader(),
    timeoutMs: 120000,
  });
  await assertOk(res);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function listComments(photoId: number): Promise<PhotoComment[]> {
  const data = await requestJSON<{ comments?: PhotoComment[] }>(
    `${API_BASE}/api/photo/photos/${photoId}/comments`,
    { headers: await authHeader() },
  );
  return data.comments ?? [];
}

export async function addComment(photoId: number, text: string): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/photo/photos/${photoId}/comments`, {
    method: 'POST',
    headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  await assertOk(res);
}

export async function setLike(photoId: number, liked: boolean): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/photo/photos/${photoId}/like`, {
    method: 'POST',
    headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ liked }),
  });
  await assertOk(res);
}

export async function setFavorite(photoId: number, favorited: boolean): Promise<void> {
  const res = await apiRequest(`${API_BASE}/api/photo/photos/${photoId}/favorite`, {
    method: 'POST',
    headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorited }),
  });
  await assertOk(res);
}
