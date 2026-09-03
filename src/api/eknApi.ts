import { API_BASE } from '../config';
import { requestJSON } from './http';
import { getToken } from './authApi';

const APP_ID = 'ekn';

async function authHeader(): Promise<Record<string, string>> {
  const token = await getToken(APP_ID);
  return { Authorization: `Bearer ${token}` };
}

export interface EknProduct {
  ekn: string;
  name: string;
  thickness: string;
  sto_number: string;
  sto_name: string;
  data?: unknown;
}

export interface EknSearchItem {
  ekn: string;
  name: string;
  thickness: string;
  sto_number: string;
  sto_name: string;
}

/** Поиск по частичному/префиксному совпадению номера ЕКН (справочник sbe-ekn). */
export async function search(query: string): Promise<EknSearchItem[]> {
  const data = await requestJSON<{ results?: EknSearchItem[] }>(
    `${API_BASE}/api/ekn/search?ekn=${encodeURIComponent(query)}`,
    { headers: await authHeader() },
  );
  return data.results ?? [];
}

/** Точный лукап по полному номеру ЕКН — null, если продукт не найден. */
export async function getProduct(ekn: string): Promise<EknProduct | null> {
  try {
    return await requestJSON<EknProduct>(`${API_BASE}/api/ekn/product/${encodeURIComponent(ekn)}`, {
      headers: await authHeader(),
    });
  } catch {
    return null;
  }
}

/** Сохраняет карточку продукта, не найденного в справочнике на момент оформления
 * заявки (данные, введённые заказчиком вручную) — для автозаполнения при следующей
 * заявке с тем же ЕКН. */
export async function setManualProduct(ekn: string, name: string, thickness: string): Promise<void> {
  await requestJSON(`${API_BASE}/api/ekn/manual/${encodeURIComponent(ekn)}`, {
    method: 'POST',
    headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, thickness }),
  });
}

/** Значения групп пожарной классификации из "сырых" данных QRC (data), если есть —
 * для предзаполнения «Целевого показателя» методов ГГ/ГВ/РП (см. RequestCreateModal). */
export function readFireGroupValue(data: unknown, field: string): string {
  if (!data || typeof data !== 'object') return '';
  const groups = (data as Record<string, unknown>).groups;
  if (!groups || typeof groups !== 'object') return '';
  const fire = (groups as Record<string, unknown>).fire_characteristics;
  if (!fire || typeof fire !== 'object') return '';
  const entry = (fire as Record<string, unknown>)[field];
  if (!entry || typeof entry !== 'object') return '';
  const value = (entry as Record<string, unknown>).value;
  return typeof value === 'string' ? value : '';
}
