import QRCode from 'qrcode';

export interface QrLabelItem {
  number: string;
  title: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** Печатный лист QR-этикеток — как в Obsidian-плагине (sbe-requests,
 * printQrSheet): QR + номер заявки + название под ним, сеткой 3 в ряд, готово
 * к печати. Один и тот же путь для печати одной этикетки и партии. */
export async function printQrLabels(items: QrLabelItem[]): Promise<void> {
  if (items.length === 0) return;
  const labels: string[] = [];
  for (const item of items) {
    const dataUrl = await QRCode.toDataURL(item.number, { width: 240, margin: 1 });
    labels.push(
      `<div class="label"><img src="${dataUrl}" alt="QR"><div class="number">${escapeHtml(item.number)}</div>` +
      `<div class="title">${escapeHtml(item.title)}</div></div>`,
    );
  }
  const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>QR-метки заявок</title>
<style>
  body { font-family: sans-serif; margin: 12px; }
  .sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .label { display: flex; flex-direction: column; align-items: center; text-align: center;
    border: 1px dashed #999; border-radius: 8px; padding: 8px; break-inside: avoid; }
  .label img { width: 160px; height: 160px; }
  .number { font-weight: 600; margin-top: 4px; }
  .title { font-size: 11px; color: #444; }
</style></head>
<body>
<div class="sheet">${labels.join('')}</div>
<script>window.onload = () => window.print();</script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(html);
  w.document.close();
}
