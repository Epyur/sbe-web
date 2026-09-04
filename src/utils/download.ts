/** Общие хелперы для скачивания файлов, полученных как base64 (xlsx/docx
 * экспорты из sbe-web api) — вынесены из RequestDetail.vue, чтобы их мог
 * переиспользовать RequestsView.vue (массовое скачивание сводного отчёта). */

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mimeType });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
