/** Персистентный кэш превью фотобанка (2026-09-05) — IndexedDB, не localStorage
 * (бинарные Blob'ы, объём архива может быть большим — localStorage слишком
 * маленький и не хранит бинарные данные напрямую). Переживает перезагрузку
 * страницы: PhotoThumb.vue проверяет эту базу ПЕРЕД тем, как идти на сервер —
 * сеть трогается только если записи нет (новое фото) или `updated_at`
 * изменился (фото отредактировано с тех пор). См. sbe-web/AGENTS.md. */

const DB_NAME = 'sbe-web-photobank';
const STORE_NAME = 'thumbs';
const DB_VERSION = 1;

export interface CachedThumb {
  id: number;
  updatedAt: string;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** Отсутствие IndexedDB (приватный режим части браузеров, квота исчерпана и
 * т.п.) не должно ломать отображение фото — просто работаем без персистентного
 * кэша (остаётся in-memory Map в PhotobankView, как было раньше). */
export async function getCachedThumb(id: number): Promise<CachedThumb | undefined> {
  try {
    const db = await openDb();
    return await new Promise<CachedThumb | undefined>((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result as CachedThumb | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

export async function putCachedThumb(entry: CachedThumb): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Не критично — превью просто не закэшируется, следующая загрузка снова
    // сходит на сервер.
  }
}
