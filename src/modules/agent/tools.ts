import type { AgentToolSchema, ToolCallResult, SourceAvailability, FileGenerateResponse, FileParseResponse } from '../../types/agent';
import { errorMessage } from '../../api/http';
import * as agentApi from '../../api/agentApi';
import { API_MANIFEST } from './apiManifest';
import { renderChartToDataUrl, dataUrlToBlob, type ChartRenderType } from './chartRenderer';
import { buildWebPresentationHtml } from './presentationRenderer';
import { DEFAULT_PRESENTATION_TEMPLATE, PRESENTATION_DESIGN_RULES } from './presentationTemplate';
import type { PresentationSlide } from './presentationTypes';

/**
 * Реестр тулов веб-агента — порт sbe-agent/src/agent/tools-registry.ts + tools/*.ts.
 * Без вольта: тулы обращаются к agentApi.ts (fetch+JWT), а не к Obsidian API.
 * Исключены (нет аналога в вебе — см. docs/superpowers/specs/
 * 2026-09-04-sbe-agent-web-design.md): get_tasks, read_local_cache, весь browser_*.
 */

export interface AgentAttachment {
  name: string;
  data: ArrayBuffer;
}

export interface AgentToolContext {
  getEmail: () => string;
  getUserName: () => string;
  getSources: () => SourceAvailability[];
  confirmUser?: (message: string) => Promise<boolean>;
}

export interface AgentTool {
  schema: AgentToolSchema;
  execute: (
    ctx: AgentToolContext,
    args: Record<string, unknown>,
    attachment: AgentAttachment | null,
  ) => Promise<ToolCallResult>;
}

// ================= Общие хелперы =================

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function matchesQuery(item: Record<string, unknown>, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return Object.entries(item).some(([, v]) => typeof v === 'string' && v.toLowerCase().includes(q));
}

function limitItems<T>(items: T[], limit: number): T[] {
  return items.slice(0, Math.max(1, Math.min(limit || 20, 200)));
}

function truncate(v: string, max: number): string {
  if (v.length <= max) return v;
  return v.slice(0, max) + '\n…';
}

// ================= create_docx/xlsx/pdf/json/mermaid/png/html =================

const paragraphSchema = {
  type: ['string', 'object'] as const,
  description: 'Абзац: строка (простой текст) ИЛИ объект с оформлением {text, align, bold, italic, underline, size, highlight, list}',
  properties: {
    text: { type: 'string', description: 'Текст абзаца' },
    align: { type: 'string', enum: ['left', 'center', 'right', 'justify'], description: 'Выравнивание' },
    bold: { type: 'boolean', description: 'Жирный' },
    italic: { type: 'boolean', description: 'Курсив' },
    underline: { type: 'boolean', description: 'Подчёркнутый' },
    size: { type: 'number', description: 'Размер шрифта, pt (6–96)' },
    highlight: { type: 'string', description: 'Выделение фона: yellow/green/red/blue/cyan/magenta/… или hex-цвет #RRGGBB' },
    list: { type: 'string', enum: ['bullet', 'number'], description: 'Маркированный (bullet) или нумерованный (number) список' },
  },
};

const tableSchema = {
  type: 'object' as const,
  properties: {
    headers: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    style: { type: 'string', enum: ['plain', 'grid', 'fancy'], description: 'plain — без границ; grid — границы (по умолчанию); fancy — границы + заливка шапки' },
    col_widths: { type: 'array', items: { type: 'number' }, description: 'Ширины колонок, см (Word/PDF)' },
    repeat_header: { type: 'boolean', description: 'Повторять шапку таблицы на каждой странице (Word)' },
  },
};

const sectionsSchema = {
  type: 'array' as const,
  items: {
    type: 'object' as const,
    properties: {
      heading: { type: 'string', description: 'Заголовок раздела' },
      level: { type: 'number', description: 'Уровень заголовка 1–6 (1 — самый крупный); используй уровни для структуры документа' },
      paragraphs: { type: 'array', items: paragraphSchema },
      table: tableSchema,
    },
  },
};

const sheetsSchema = {
  type: 'array' as const,
  items: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Название листа' },
      title: { type: 'string', description: 'Титульный ряд (объединяется по ширине листа, крупный шрифт)' },
      headers: { type: 'array', items: { type: 'string' } },
      rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      auto_filter: { type: 'boolean', description: 'Включить фильтр по колонкам (для строк — очень полезно)' },
      freeze_header: { type: 'boolean', description: 'Закрепить шапку при прокрутке' },
      col_widths: { type: 'array', items: { type: 'number' }, description: 'Ширины колонок' },
      wrap: { type: 'boolean', description: 'Перенос текста в ячейках' },
    },
  },
};

async function generateFileTool(format: string, spec: Record<string, unknown>, label: string): Promise<ToolCallResult> {
  try {
    const data: FileGenerateResponse = await agentApi.generateFile(format, spec);
    const until = new Date(data.expires_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    let summary = `Файл **${data.file_name}** (${label}) сформирован. Скачивание доступно до ${until}.`;
    if (data.extra) {
      if (data.extra.svg) summary += `\nSVG-версия: ${data.extra.svg}`;
      if (data.extra.mmd) summary += `\nИсходник mermaid (.mmd): ${data.extra.mmd}`;
    }
    return { ok: true, summary, link: { url: data.url, label: `⬇ Скачать файл ${label}` }, data };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

// ================= create_png (chart) — рендер в браузере через ApexCharts =================
// Рендер (тип/легенда/подписи осей) теперь делает клиент, не сервер через
// mermaid — mermaid xychart-beta физически не умеет ни легенду, ни подпись
// оси Y. См. docs/superpowers/specs/2026-09-06-web-agent-chart-rendering-design.md.

const VALID_CHART_TYPES = new Set<ChartRenderType>(['bar', 'line', 'donut', 'pie', 'area', 'scatter']);

async function renderChartTool(chart: Record<string, unknown>): Promise<ToolCallResult> {
  const typeArg = String(chart.type || 'bar').trim() as ChartRenderType;
  const chartType: ChartRenderType = VALID_CHART_TYPES.has(typeArg) ? typeArg : 'bar';
  const title = String(chart.title || 'График').trim();
  const legend = chart.legend === undefined ? true : Boolean(chart.legend);
  const xLabel = typeof chart.x_label === 'string' ? chart.x_label.trim() || undefined : undefined;
  const yLabel = typeof chart.y_label === 'string' ? chart.y_label.trim() || undefined : undefined;

  let categories: string[];
  let series: { name: string; data: number[] }[];
  if (Array.isArray(chart.data) && chart.data.length > 0) {
    const points = chart.data as Array<{ label?: unknown; value?: unknown }>;
    categories = points.map(p => String(p.label ?? ''));
    series = [{ name: title, data: points.map(p => Number(p.value) || 0) }];
  } else if (Array.isArray(chart.categories) && Array.isArray(chart.series)) {
    categories = (chart.categories as unknown[]).map(String);
    series = (chart.series as Array<{ name?: unknown; values?: unknown[] }>).map(s => ({
      name: String(s.name || ''),
      data: Array.isArray(s.values) ? s.values.map(Number) : [],
    }));
  } else {
    return { ok: false, summary: '', error: 'Требуется chart.data ({label,value}[]) или chart.categories + chart.series.' };
  }
  if (series.length === 0 || series.every(s => s.data.length === 0)) {
    return { ok: false, summary: '', error: 'Нет данных для графика.' };
  }
  if ((chartType === 'donut' || chartType === 'pie') && series.length !== 1) {
    return { ok: false, summary: '', error: 'Для donut/pie нужен ровно один ряд (chart.data, не несколько series).' };
  }

  try {
    const dataUrl = await renderChartToDataUrl({ chartType, title, categories, series, xLabel, yLabel, legend });
    const blob = dataUrlToBlob(dataUrl);
    const fileName = title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'chart';
    const result = await agentApi.storeClientFile(blob, fileName, '.png');
    const until = new Date(result.expires_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return {
      ok: true,
      summary: `График «${title}» (${chartType}) сформирован. Скачивание доступно до ${until}.`,
      link: { url: result.url, label: '📊 Открыть график' },
      data: result,
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

// ================= create_presentation =================
// Реальный формат слайдов sbe-presentations (не плоский HTML-отчёт) — порт
// presentation-generator.ts, рендерится в браузере. См. docs/superpowers/
// specs/2026-09-06-web-agent-presentations-design.md.

const BACKGROUND_LAYOUTS = new Set(['title', 'section', 'photo', 'final']);

interface PresentationSlideArg extends PresentationSlide {
  image_url?: string;
  image_fit?: 'cover' | 'contain';
}

async function createPresentationTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const title = String(args.title || '').trim();
  const slidesArg = Array.isArray(args.slides) ? (args.slides as PresentationSlideArg[]) : [];
  if (!title || slidesArg.length === 0) {
    return { ok: false, summary: '', error: 'Требуются title и непустой slides.' };
  }

  const images: Record<string, string> = {};
  const illustrations: Record<string, string> = {};
  const imageFit: Record<string, 'cover' | 'contain'> = {};
  const slides: PresentationSlide[] = slidesArg.map((s, i) => {
    const { image_url: imageUrl, image_fit: fit, ...rest } = s;
    const slide: PresentationSlide = { ...rest };
    if (imageUrl) {
      if (BACKGROUND_LAYOUTS.has(slide.layout)) {
        const key = slide.layout === 'title' ? 'bg:title' : `bg:${i}`;
        images[key] = imageUrl;
        if (fit) imageFit[key] = fit;
      } else {
        illustrations[imageUrl] = imageUrl;
        slide.imagePath = imageUrl;
        if (fit) imageFit[imageUrl] = fit;
      }
    }
    return slide;
  });

  const presenter = String(args.presenter || '').trim() || undefined;
  const presenterPhone = String(args.presenter_phone || '').trim() || undefined;
  const presenterEmail = String(args.presenter_email || '').trim() || undefined;
  const date = String(args.date || '').trim() || undefined;

  try {
    const html = await buildWebPresentationHtml(
      { title, slides },
      DEFAULT_PRESENTATION_TEMPLATE,
      images,
      { date, presenter, presenterPhone, presenterEmail, illustrations, imageFit },
    );
    const blob = new Blob([html], { type: 'text/html' });
    const fileName = title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'presentation';
    const result = await agentApi.storeClientFile(blob, fileName, '.html');
    const until = new Date(result.expires_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return {
      ok: true,
      summary: `Презентация «${title}» (${slides.length} слайдов) сформирована. Открой ссылку и переключи в режим «Слайды» (⛶ для полноэкранного показа). Доступна до ${until}.`,
      link: { url: result.url, label: '🖥 Открыть презентацию' },
      data: result,
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

// ================= parse_file / read_text_part =================

function sanitizeParsedName(fileName: string): string {
  const base = (fileName || 'file').replace(/\.[^.]+$/, '');
  const clean = base.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').slice(0, 80);
  return clean || 'document';
}

const PARSE_TEXT_LIMIT = 24000;

async function parseFileTool(attachment: AgentAttachment | null): Promise<ToolCallResult> {
  if (!attachment) {
    return { ok: false, summary: '', error: 'В сообщении нет прикреплённого файла. Попросите пользователя прикрепить файл.' };
  }
  try {
    const file = new File([attachment.data], attachment.name);
    const parsed: FileParseResponse = await agentApi.parseFile(file);

    let scratchKey = '';
    if (parsed.text && parsed.text.length > PARSE_TEXT_LIMIT) {
      const total = parsed.text.length;
      const safe = sanitizeParsedName(attachment.name);
      const saved = await agentApi.saveScratchText(safe, parsed.text);
      scratchKey = saved.key;
      const head = PARSE_TEXT_LIMIT - 1000;
      const tail = 800;
      parsed.text = parsed.text.slice(0, head)
        + `\n…[текст сокращён для анализа: показано начало и конец из ${total} символов; ПОЛНЫЙ текст сохранён (48 часов): key="${scratchKey}" — читай его частями через read_text_part(key, start)]…\n`
        + parsed.text.slice(-tail);
    }

    let summary = `Файл **${attachment.name}** разобран (${parsed.kind}).`;
    const textLen = parsed.text ? parsed.text.length : 0;
    summary += ` Символов текста: ${textLen}.`;
    if (scratchKey) {
      summary += `\nДокумент большой — полный текст сохранён на 48 часов. Читай его частями: вызови read_text_part с key="${scratchKey}" и start=0, затем повторяй с увеличивающимся start, пока не получишь «конец документа».`;
    }
    if (parsed.text) {
      const snippet = parsed.text.slice(0, 600);
      summary += `\n\n\`\`\`\n${snippet}${parsed.text.length > 600 ? '\n…' : ''}\n\`\`\``;
    }
    if (parsed.sheets) summary += ` Листов: ${parsed.sheets.length}.`;
    if (parsed.kind === 'json' && parsed.data !== undefined) {
      let jsonSnippet = '';
      try { jsonSnippet = JSON.stringify(parsed.data); } catch { jsonSnippet = String(parsed.data); }
      summary += `\n\n\`\`\`json\n${jsonSnippet.slice(0, 600)}${jsonSnippet.length > 600 ? '\n…' : ''}\n\`\`\``;
    }
    return { ok: true, summary, data: parsed };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function readTextPartTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const key = String(args.key || args.path || '').trim();
  if (!key) {
    return { ok: false, summary: '', error: 'Требуется key (из parse_file).' };
  }
  const start = Math.max(0, Math.floor(Number(args.start) || 0));
  const length = Math.min(24000, Math.max(500, Math.floor(Number(args.length) || 24000)));
  try {
    const chunk = await agentApi.readScratchText(key, start, length);
    if (chunk.total === 0 && chunk.text === '' && chunk.done) {
      return { ok: true, summary: 'Достигнут конец документа.' };
    }
    const remaining = chunk.total - chunk.end;
    const tail = remaining > 0
      ? `\n…(осталось ${remaining} символов; вызови read_text_part с key="${key}" и start=${chunk.end})`
      : '\n(конец документа)';
    return { ok: true, summary: `Символы ${chunk.start}–${chunk.end} из ${chunk.total}:\n\`\`\`\n${chunk.text}\n\`\`\`${tail}` };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

// ================= get_emails / get_documents / get_contacts / get_lims_requests =================
// В отличие от Obsidian-плагина — ВСЕГДА напрямую в БД сервера (нет локального
// кэша в вебе, ветка withServerFallback удалена целиком).

async function getEmailsTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim();
    const limit = Number(args.limit) || 20;
    const direction = String(args.direction || '').trim();
    let items = await agentApi.pullSourceItems('mailer', 'emails');
    if (direction) items = items.filter(i => str(i.direction_name).toLowerCase().includes(direction.toLowerCase()));
    items = items.filter(i => matchesQuery(i, query));
    const picked = limitItems(items, limit).map(i => ({
      id: i.id, number: i.number, topic: str(i.subject || i.topic), author: i.author,
      direction_name: i.direction_name, date: str(i.date || i.created_at), text: truncate(str(i.text), 3000),
    }));
    return { ok: true, summary: `Письма (источник: server): найдено ${items.length}, показано ${picked.length}.`, data: { source: 'server', total: items.length, items: picked } };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function getDocumentsTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim();
    const limit = Number(args.limit) || 20;
    let items = await agentApi.pullSourceItems('documents', 'documents');
    items = items.filter(i => matchesQuery(i, query));
    const picked = limitItems(items, limit).map(i => ({
      id: i.id, title: i.title, doc_type: i.doc_type, curator_email: i.curator_email, deadline: i.deadline,
      file_name: i.file_name, file_key: i.file_key, link_url: i.link_url, parent_id: i.parent_id, completed: i.completed, updated_at: i.updated_at,
    }));
    return { ok: true, summary: `Документы (источник: server): найдено ${items.length}, показано ${picked.length}.`, data: { source: 'server', total: items.length, items: picked } };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function getDocumentLinkTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const fileKey = String(args.file_key || '').trim();
  if (!fileKey) return { ok: false, summary: '', error: 'Требуется поле file_key (из get_documents).' };
  try {
    const url = await agentApi.getDocumentLink(fileKey);
    if (!url) return { ok: false, summary: '', error: 'Сервер не вернул ссылку на файл.' };
    return {
      ok: true,
      summary: 'Ссылка на файл документа получена — пользователю показана кнопка «Открыть файл» (действует ~7 дней). Скажи пользователю, что можно открыть/скачать документ кнопкой в сообщении тула; НЕ вставляй длинный URL в текст ответа.',
      link: { url, label: '📄 Открыть файл' },
      data: { url },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function getContactsTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim();
    const limit = Number(args.limit) || 20;
    let items = await agentApi.pullSourceItems('contacts', 'contacts');
    items = items.filter(i => matchesQuery(i, query));
    const picked = limitItems(items, limit).map(i => ({
      id: i.id, name: i.name, phone: i.phone, email: i.email, organization: i.organization,
      position: i.position, org_type: i.org_type, notes: i.notes, curator_email: i.curator_email,
    }));
    return { ok: true, summary: `Контакты (источник: server): найдено ${items.length}, показано ${picked.length}.`, data: { source: 'server', total: items.length, items: picked } };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** YYYY-MM-DD (или полный ISO) → «YYYY-MM-DD» для лексикографического сравнения дат. */
function dateOnly(v: unknown): string {
  const s = str(v);
  return s.length >= 10 ? s.slice(0, 10) : '';
}

function inRange(dateStr: unknown, from: string, to: string): boolean {
  const d = dateOnly(dateStr);
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/** Начало периода (день/неделя-с-понедельника/месяц) для даты, уже прошедшей inRange. */
function bucketKey(dateStr: unknown, granularity: 'day' | 'week' | 'month'): string {
  const d = dateOnly(dateStr);
  if (granularity === 'day') return d;
  if (granularity === 'month') return d.slice(0, 7);
  const dt = new Date(`${d}T00:00:00Z`);
  const isoDow = dt.getUTCDay() || 7; // Пн=1..Вс=7
  dt.setUTCDate(dt.getUTCDate() - isoDow + 1);
  return dt.toISOString().slice(0, 10);
}

async function getLimsRequestsTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    const status = String(args.status || '').trim();
    const compliance = String(args.compliance || '').trim();
    const labQuery = String(args.lab || '').trim();
    const dateFrom = dateOnly(args.date_from);
    const dateTo = dateOnly(args.date_to);
    const groupBy = String(args.group_by || '').trim();
    const limit = Number(args.limit) || 20;
    let items = await agentApi.getLimsRequests();

    let labNote = '';
    if (labQuery) {
      const labs = await agentApi.getLimsLabs();
      const q = labQuery.toLowerCase();
      const matched = labs.filter(l => str(l.name).toLowerCase().includes(q) || str(l.code).toLowerCase().includes(q));
      if (matched.length === 0) {
        const available = labs.map(l => str(l.name)).filter(Boolean).join(', ');
        return { ok: false, summary: '', error: `Лаборатория «${labQuery}» не найдена. Доступные лаборатории: ${available || 'нет данных'}.` };
      }
      const matchedIds = new Set(matched.map(l => l.id));
      items = items.filter(i => matchedIds.has(i.lab_id));
      labNote = `, лаборатория: ${matched.map(l => str(l.name)).join(', ')}`;
    }
    if (status) items = items.filter(i => str(i.status).toLowerCase() === status.toLowerCase());
    if (compliance) items = items.filter(i => str(i.compliance).toLowerCase() === compliance.toLowerCase());
    if (dateFrom || dateTo) {
      items = items.filter(i => inRange(i.created_at, dateFrom, dateTo) || inRange(i.completed_at, dateFrom, dateTo));
    }
    const dateNote = (dateFrom || dateTo) ? `, период: ${dateFrom || '…'}..${dateTo || '…'} (по дате регистрации ИЛИ завершения)` : '';

    if (groupBy === 'day' || groupBy === 'week' || groupBy === 'month') {
      const buckets = new Map<string, { period: string; arrived: number; completed: number }>();
      const bump = (dateStr: unknown, field: 'arrived' | 'completed') => {
        if (!inRange(dateStr, dateFrom, dateTo)) return;
        const key = bucketKey(dateStr, groupBy);
        const entry = buckets.get(key) || { period: key, arrived: 0, completed: 0 };
        entry[field]++;
        buckets.set(key, entry);
      };
      for (const i of items) {
        bump(i.created_at, 'arrived');
        bump(i.completed_at, 'completed');
      }
      const series = [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period));
      return {
        ok: true,
        summary: `Заявки ЛИМС, счёт по ${groupBy} (источник: server${labNote}${dateNote}): заявок в выборке ${items.length}, периодов в графике ${series.length}. Уже посчитано — НЕ пересчитывай вручную по отдельным заявкам, бери data.series как готовые точки графика (period — подпись оси X, arrived — поступление, completed — завершение).`,
        data: { source: 'server', total: items.length, series },
      };
    }

    const picked = limitItems(items, limit).map(i => ({
      id: i.id, title: i.title, customer_number: i.customer_number, lab_number: i.lab_number,
      status: i.status, result: i.result, compliance: i.compliance, owner_email: i.owner_email,
      created_at: i.created_at, updated_at: i.updated_at, completed_at: i.completed_at,
    }));
    return {
      ok: true,
      summary: `Заявки ЛИМС (источник: server${labNote}${dateNote}): найдено ${items.length}, показано ${picked.length}.`,
      data: { source: 'server', total: items.length, items: picked },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

// ================= get_photos / get_photo_link =================

async function getPhotosTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim();
    const kind = String(args.kind || '').trim();
    const limit = Number(args.limit) || 20;
    const id = Number(args.id) || 0;
    let items = await agentApi.getPhotos();
    if (id > 0) {
      items = items.filter(i => Number(i.id) === id);
    } else if (kind) {
      items = items.filter(i => str(i.kind).toLowerCase() === kind.toLowerCase());
    }
    if (query && id <= 0) {
      const q = query.toLowerCase();
      items = items.filter(i => Object.entries(i).some(([k, v]) => {
        if (k === 'custom') return false;
        return typeof v === 'string' && v.toLowerCase().includes(q);
      }) || (Array.isArray(i.tags) && i.tags.some((t: unknown) => typeof t === 'string' && t.toLowerCase().includes(q))));
    }
    const picked = items.slice(0, Math.max(1, Math.min(limit, 200))).map(i => ({
      id: i.id, title: i.title, description: str(i.description), tags: i.tags, folder_id: i.folder_id,
      folder_name: i.folder_name, kind: i.kind, file_key: i.file_key, file_name: i.file_name, mime_type: i.mime_type,
      width: i.width, height: i.height, location: i.location, author_email: i.author_email, created_at: i.created_at,
    }));
    return { ok: true, summary: `Фотобанк (источник: server): найдено ${items.length}, показано ${picked.length}.`, data: { source: 'server', total: items.length, items: picked } };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function getPhotoLinkTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const fileKey = String(args.file_key || '').trim();
  if (!fileKey) return { ok: false, summary: '', error: 'Требуется поле file_key (из get_photos).' };
  try {
    const url = await agentApi.getPhotoLink(fileKey);
    if (!url) return { ok: false, summary: '', error: 'Сервер не вернул ссылку на файл.' };
    return {
      ok: true,
      summary: 'Ссылка на файл получена — пользователю показана кнопка «Открыть фото» (действует ~7 дней). Скажи пользователю, что можно открыть фото кнопкой в сообщении тула; НЕ вставляй длинный URL в текст ответа.',
      link: { url, label: '🖼 Открыть фото' },
      data: { url },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

// ================= YouGile (agent-service — прокси, без CORS-проблемы браузера) =================
// Пароль YouGile и обмен на ключ — целиком на сервере (agent-service, см.
// agentApi.ts); тулы здесь только формируют/фильтруют данные для модели.
// Удаления НЕТ ни одного тула — ни задач, ни досок, ни проектов, категорически
// запрещено пользователем. См. docs/superpowers/specs/
// 2026-09-06-web-agent-yougile-design.md.

async function getYougileTasksTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    const query = String(args.query || '').trim().toLowerCase();
    const columnId = String(args.column_id || '').trim();
    const assignedTo = String(args.assigned_to || '').trim();
    const mine = args.mine === true;
    const limit = Math.max(1, Math.min(Number(args.limit) || 30, 200));
    let items = await agentApi.getYougileTasks({ columnId, assignedTo, mine });
    if (query) {
      items = items.filter(t => Object.values(t).some(v => typeof v === 'string' && v.toLowerCase().includes(query)));
    }
    const picked = items.slice(0, limit);
    return {
      ok: true,
      summary: `YouGile: найдено задач ${items.length}, показано ${picked.length}.`,
      data: { total: items.length, items: picked },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function getYougileBoardTreeTool(): Promise<ToolCallResult> {
  try {
    const tree = await agentApi.getYougileBoardTree();
    return {
      ok: true,
      summary: `YouGile: проектов ${tree.projects.length}, досок ${tree.boards.length}, колонок ${tree.columns.length}, пользователей ${tree.users.length}. Используй id колонки для создания задачи (create_yougile_task) и смены статуса (set_yougile_task_status).`,
      data: tree,
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function getYougileTaskStatsTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const dateFrom = String(args.date_from || '').trim();
  const dateTo = String(args.date_to || '').trim();
  const groupBy = String(args.group_by || '').trim();
  if (!dateFrom || !dateTo || !['day', 'week', 'month'].includes(groupBy)) {
    return { ok: false, summary: '', error: 'Требуются date_from, date_to (YYYY-MM-DD) и group_by (day/week/month).' };
  }
  try {
    const stats = await agentApi.getYougileTaskStats(dateFrom, dateTo, groupBy as 'day' | 'week' | 'month');
    return {
      ok: true,
      summary: `YouGile: период ${dateFrom}..${dateTo}, периодов в графике ${stats.series.length}, исполнителей ${stats.by_executor.length}. Уже посчитано — НЕ пересчитывай вручную по отдельным задачам, бери data.series как готовые точки графика (period — подпись оси X, arrived — поступление, completed — завершение) и data.by_executor как готовую разбивку по людям (created/completed).`,
      data: stats,
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function createYougileTaskTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const title = String(args.title || '').trim();
  const columnId = String(args.column_id || '').trim();
  if (!title || !columnId) {
    return { ok: false, summary: '', error: 'Требуются поля title и column_id (узнай id колонки через get_yougile_board_tree).' };
  }
  try {
    const payload: Record<string, unknown> = { title, columnId };
    const description = String(args.description || '').trim();
    if (description) payload.description = description;
    if (Array.isArray(args.assigned)) payload.assigned = args.assigned.map(String);
    const task = await agentApi.createYougileTask(payload);
    return {
      ok: true,
      summary: `YouGile: задача «${title}» создана (id ${String(task.id || '?')}).`,
      data: task,
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function setYougileTaskStatusTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const taskId = String(args.task_id || '').trim();
  const columnId = String(args.column_id || '').trim();
  if (!taskId || !columnId) {
    return { ok: false, summary: '', error: 'Требуются поля task_id и column_id (узнай id колонки через get_yougile_board_tree).' };
  }
  try {
    await agentApi.setYougileTaskStatus(taskId, columnId);
    return { ok: true, summary: `YouGile: статус задачи ${taskId} изменён.`, data: { task_id: taskId, column_id: columnId } };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function addYougileTaskMessageTool(args: Record<string, unknown>, attachment: AgentAttachment | null): Promise<ToolCallResult> {
  const taskId = String(args.task_id || '').trim();
  const text = String(args.text || '').trim();
  if (!taskId) return { ok: false, summary: '', error: 'Требуется поле task_id.' };
  if (!text && !attachment) return { ok: false, summary: '', error: 'Нужен текст (text) или прикреплённый пользователем файл.' };
  try {
    const file = attachment ? new File([attachment.data], attachment.name) : undefined;
    await agentApi.addYougileTaskMessage(taskId, text, file);
    return {
      ok: true,
      summary: `YouGile: сообщение в чат задачи ${taskId} отправлено${attachment ? ` (с файлом «${attachment.name}»)` : ''}.`,
      data: { task_id: taskId },
    };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

// ================= describe_api / call_api =================
// Белый список эндпоинтов — apiManifest.ts. Не даёт агенту доступ к произвольному
// пути/методу — только к перечисленным там GET-эндпоинтам сервисов, к которым у
// пользователя и так есть права (сервер сам проверяет JWT/requirePerm).

function describeApiTool(ctx: AgentToolContext, args: Record<string, unknown>): ToolCallResult {
  const appId = String(args.app_id || '').trim();
  const availableAppIds = new Set(ctx.getSources().filter(s => s.available).map(s => s.appId));
  const entries = API_MANIFEST.filter(e => availableAppIds.has(e.appId) && (!appId || e.appId === appId));
  return {
    ok: true,
    summary: `Доступно эндпоинтов: ${entries.length}${appId ? ` для app_id «${appId}»` : ''}. Вызывай их через call_api.`,
    data: {
      endpoints: entries.map(e => ({
        app_id: e.appId, path: e.path, method: 'GET', description: e.description,
        path_params: e.pathParams, query: e.query,
      })),
    },
  };
}

function fillPathParams(path: string, pathParams: Record<string, unknown>): string {
  return path.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const v = pathParams[key];
    if (v === undefined || v === null || v === '') throw new Error(`Не хватает параметра пути «${key}» для ${path} — передай его в path_params.`);
    return encodeURIComponent(String(v));
  });
}

async function callApiTool(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    const appId = String(args.app_id || '').trim();
    const path = String(args.path || '').trim();
    const availableAppIds = new Set(ctx.getSources().filter(s => s.available).map(s => s.appId));
    if (!availableAppIds.has(appId)) return { ok: false, summary: '', error: `Нет доступа к app_id «${appId}» (проверь источники или вызови describe_api).` };
    const entry = API_MANIFEST.find(e => e.appId === appId && e.path === path);
    if (!entry) return { ok: false, summary: '', error: `Эндпоинт «${path}» для app_id «${appId}» не в белом списке — сначала вызови describe_api, чтобы увидеть доступные пути.` };

    const pathParamsArg = (args.path_params && typeof args.path_params === 'object') ? args.path_params as Record<string, unknown> : {};
    const resolvedPath = fillPathParams(entry.path, pathParamsArg);

    const queryArg = (args.query && typeof args.query === 'object') ? args.query as Record<string, unknown> : {};
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(queryArg)) if (v !== undefined && v !== null) query[k] = String(v);

    const result = await agentApi.callAppApi(appId, resolvedPath, query);

    // Общая защита от раздувания контекста: если в ответе есть массив длиннее лимита — обрезаем его.
    const limit = Math.max(1, Math.min(Number(args.limit) || 50, 200));
    let payload = result;
    let note = '';
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const obj = result as Record<string, unknown>;
      for (const [key, val] of Object.entries(obj)) {
        if (Array.isArray(val) && val.length > limit) {
          note = `, массив «${key}»: ${val.length}, показано ${limit}`;
          payload = { ...obj, [key]: val.slice(0, limit) };
          break;
        }
      }
    } else if (Array.isArray(result) && result.length > limit) {
      note = `, массив: ${result.length}, показано ${limit}`;
      payload = result.slice(0, limit);
    }
    return { ok: true, summary: `call_api ${appId} ${resolvedPath}${note}`, data: payload };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

// ================= Скилы (только глобальные) =================

async function addSkillTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const repoUrl = String(args.repo_url || '').trim();
  const skillPath = String(args.skill_path || '').trim();
  const targetName = (skillPath || repoUrl.split('/').filter(Boolean).pop() || '').toLowerCase();
  try {
    const globals = await agentApi.listGlobalSkills();
    const hit = globals.find(g => g.name.toLowerCase() === targetName);
    if (hit) {
      return { ok: true, summary: `Скил «${hit.name}» уже установлен ГЛОБАЛЬНО (источник — сервер, проверен администратором) и доступен: используй list_skills, затем read_skill.` };
    }
    return { ok: false, summary: '', error: 'В веб-версии доступны только глобальные скилы (одобренные администратором). Этого скила нет в списке — обратитесь к администратору, чтобы добавить его глобально.' };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function listSkillsTool(): Promise<ToolCallResult> {
  try {
    const globals = await agentApi.listGlobalSkills();
    if (globals.length === 0) {
      return { ok: true, summary: 'Скилов нет. Обратитесь к администратору за глобальным скилом.', data: [] };
    }
    const skills = globals.map(g => ({ name: g.name, description: g.description, global: true }));
    const summary = `Скилы (${skills.length}):\n` + skills.map(s => `- 🌐 **${s.name}**: ${s.description || '—'}`).join('\n')
      + '\n\n🌐 — глобальные скилы (утверждены администратором, доступны с сервера).';
    return { ok: true, summary, data: skills };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function readSkillTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const name = String(args.name || '').trim();
  if (!name) return { ok: false, summary: '', error: 'Требуется name (имя скила).' };
  try {
    const g = await agentApi.getGlobalSkill(name);
    if (!g) return { ok: false, summary: '', error: `Скил «${name}» не найден. Сначала вызовите list_skills.` };
    return { ok: true, summary: `Глобальный скил «${g.name}» загружен. Следуй его инструкциям.`, data: { name: g.name, skill_md: g.content, files: g.files } };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

// ================= Правила =================

async function saveRuleTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const content = String(args.content || '').trim();
  if (!content) return { ok: false, summary: '', error: 'Требуется content (текст правил).' };
  const path = String(args.path || '').trim() || 'правила.md';
  const append = args.append === true;
  try {
    await agentApi.saveRule(path, content, append);
    return { ok: true, summary: `Правило сохранено: ${path}. Применяется автоматически в новых диалогах.`, data: { path } };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function listRulesTool(): Promise<ToolCallResult> {
  try {
    const rules = await agentApi.getRules();
    if (rules.length === 0) return { ok: true, summary: 'Правил нет.', data: [] };
    const summary = `Правила (${rules.length}):\n` + rules.map(r => `- ${r.path}`).join('\n');
    return { ok: true, summary, data: rules.map(r => ({ path: r.path })) };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

async function readRuleTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const path = String(args.path || '').trim();
  if (!path) return { ok: false, summary: '', error: 'Требуется path.' };
  try {
    const rules = await agentApi.getRules();
    const rule = rules.find(r => r.path === path);
    if (!rule) return { ok: false, summary: '', error: `Файл не найден: ${path}` };
    return { ok: true, summary: `Содержимое ${path}:`, data: { path: rule.path, content: rule.content } };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

/** Все правила пользователя одним блоком — для системного промпта (см. agentEngine.ts). */
export async function loadAllRules(): Promise<string> {
  try {
    const rules = await agentApi.getRules();
    if (rules.length === 0) return '';
    return rules.filter(r => r.content.trim()).map(r => `### ${r.path}\n${r.content.trim()}`).join('\n\n');
  } catch (e: unknown) {
    console.warn('LogicTEAM.007: не удалось загрузить правила:', errorMessage(e));
    return '';
  }
}

// ================= fetch_url =================

const FETCH_TEXT_LIMIT = 12000;
const EXAMPLE_LIMIT = 600;

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

function compactHtml(html: string): string {
  const scripts = Array.from(html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)).map(m => m[1]);
  const links = Array.from(html.matchAll(/<a[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)).map(m => m[1]).slice(0, 40);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
  const parts: string[] = [];
  if (scripts.length) parts.push('SCRIPTS (подключаемые .js — загрузите их через fetch_url и ищите AJAX-эндпоинт, напр. DataTables ajax.url):\n' + scripts.join('\n'));
  if (links.length) parts.push('LINKS (первые 40):\n' + links.join('\n'));
  if (text) parts.push(`TEXT (${text.length} симв.):\n` + text.slice(0, 6000));
  return parts.join('\n\n');
}

interface JsonSummary {
  kind: 'table' | 'json' | 'truncated';
  parts: string[];
  data: Record<string, unknown>;
  remainingPages?: number;
  pageRecords?: unknown[];
}

function summarizeJson(text: string): JsonSummary {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    return { kind: 'truncated', parts: ['JSON повреждён или обрезан (серверный лимит ответа 1 МБ). Уменьшите размер страницы: для DataTables используйте length=50–100.'], data: { json_truncated: true } };
  }
  const isTableLike = Array.isArray(parsed) || (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).data));
  if (!isTableLike) {
    const json = JSON.stringify(parsed);
    const view = json.slice(0, FETCH_TEXT_LIMIT);
    return { kind: 'json', parts: [`JSON (${json.length} симв.):\n${view}${json.length > FETCH_TEXT_LIMIT ? '\n…(обрезано)' : ''}`], data: { json: view, total: json.length } };
  }
  let records: unknown[]; let recordsTotal: number | undefined; let recordsFiltered: number | undefined;
  if (Array.isArray(parsed)) {
    records = parsed; recordsTotal = recordsFiltered = records.length;
  } else {
    const obj = parsed as Record<string, unknown>;
    records = Array.isArray(obj.data) ? (obj.data as unknown[]) : [];
    recordsTotal = toNumber(obj.recordsTotal);
    recordsFiltered = toNumber(obj.recordsFiltered);
  }
  const pageCount = records.length;
  const examples = records.slice(0, 3);
  const parts: string[] = ['DataTables/табличный JSON:'];
  if (recordsTotal !== undefined) parts.push(`recordsTotal (всего в базе): ${recordsTotal}`);
  if (recordsFiltered !== undefined) parts.push(`recordsFiltered (по фильтру): ${recordsFiltered}`);
  parts.push(`страница (data.length): ${pageCount}`);
  if (examples.length > 0) {
    parts.push('Пример записей (первые 3, усечены):\n' + examples.map((e, i) => {
      const s = JSON.stringify(e);
      return `${i + 1}) ${s.length > EXAMPLE_LIMIT ? s.slice(0, EXAMPLE_LIMIT) + '…' : s}`;
    }).join('\n'));
  }
  let remainingPages: number | undefined;
  if (recordsFiltered !== undefined && recordsFiltered > pageCount) remainingPages = Math.ceil(recordsFiltered / Math.max(pageCount, 1));
  return { kind: 'table', parts, data: { datatable: true, records_total: recordsTotal, records_filtered: recordsFiltered, page_records: pageCount, examples, records }, remainingPages, pageRecords: records };
}

async function fetchUrlTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const url = String(args.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, summary: '', error: 'Нужен полный URL (http/https).' };
  try {
    const payload: { method?: string; url: string; body?: string; headers?: Record<string, string>; timeout_ms?: number } = {
      method: String(args.method || 'GET').toUpperCase(), url,
    };
    if (args.body !== undefined && args.body !== null) payload.body = String(args.body);
    if (args.headers && typeof args.headers === 'object') payload.headers = args.headers as Record<string, string>;
    if (typeof args.timeout_ms === 'number') payload.timeout_ms = args.timeout_ms;

    const data = await agentApi.fetchUrl(payload);
    const text = data.text || '';
    const contentType = (data.content_type || '').split(';')[0].trim().toLowerCase();

    const saveTo = typeof args.save_to === 'string' ? args.save_to.trim() : '';

    let summary = '';
    let resultData: Record<string, unknown>;
    if (contentType.includes('json') || /^\s*[[{]/.test(text)) {
      const sum = summarizeJson(text);
      if (saveTo) {
        if (sum.kind !== 'table') {
          return { ok: false, summary: '', error: 'save_to применим только к табличным JSON-ответам (DataTables с массивом data). Этот ответ — не таблица.' };
        }
        const records = sum.pageRecords || [];
        const saved = await agentApi.saveScratchRecords(records, { name: saveTo });
        const parts = [...sum.parts];
        parts.push(`Сохранено: key="${saved.key}" (записей этой страницы: ${saved.added}, всего в накопителе: ${saved.total}).`);
        if (sum.remainingPages !== undefined) parts.push(`Осталось страниц: ${sum.remainingPages}. Продолжай пагинацию start += ${records.length}, передавая тот же save_to, пока не соберёшь recordsFiltered записей.`);
        summary = `HTTP ${data.status} (${contentType}), ${text.length} симв. Записи сохранены.\n${parts.join('\n')}`;
        resultData = { status: data.status, content_type: contentType, total: text.length, key: saved.key, saved_added: saved.added, saved_total: saved.total };
      } else {
        const view = sum.parts.join('\n') + (sum.remainingPages !== undefined
          ? `\nОсталось страниц: ${sum.remainingPages}. Сохрани records этой страницы через fetch_url(save_to=...) и продолжай пагинацию.`
          : '');
        summary = `HTTP ${data.status} (${contentType}), ${text.length} симв.\n${view}`;
        resultData = { status: data.status, content_type: contentType, total: text.length, ...sum.data };
      }
    } else if (contentType.includes('html')) {
      const view = compactHtml(text);
      summary = `HTTP ${data.status} (${contentType}), ${text.length} симв. HTML — компактное представление:\n${view}`;
      resultData = { status: data.status, content_type: contentType, compact: view, total: text.length };
    } else {
      const view = text.slice(0, FETCH_TEXT_LIMIT);
      summary = `HTTP ${data.status} (${contentType}), ${text.length} симв.:\n${view}`;
      resultData = { status: data.status, content_type: contentType, text: view, total: text.length };
    }
    return { ok: true, summary, data: resultData };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

// ================= save_records / build_xlsx_from_records =================

async function saveRecordsTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const records = args.records;
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, summary: '', error: 'Требуется records — массив записей этой страницы.' };
  }
  const key = typeof args.key === 'string' ? args.key : undefined;
  const name = typeof args.name === 'string' ? args.name : undefined;
  if (!key && !name) return { ok: false, summary: '', error: 'Требуется key (продолжение) или name (новый накопитель).' };
  const mode = args.mode === 'overwrite' ? 'overwrite' : 'append';
  try {
    const saved = await agentApi.saveScratchRecords(records, { key, name, mode });
    return { ok: true, summary: `Сохранено ${saved.added} новых записей (${mode}). key="${saved.key}". Всего в накопителе: ${saved.total}.`, data: saved };
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

function cleanCellText(v: string): string {
  return v
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<\/?[a-z][a-z0-9]*[^>]*>/gi, '')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

function cellValue(v: unknown): string | number {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return cleanCellText(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  try { return cleanCellText(JSON.stringify(v)); } catch { return String(v); }
}

async function buildXlsxFromRecordsTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const key = String(args.key || '').trim();
  if (!key) return { ok: false, summary: '', error: 'Требуется key (из save_records/fetch_url save_to).' };
  try {
    const { records } = await agentApi.readScratchRecords(key);
    if (records.length === 0) return { ok: false, summary: '', error: `В накопителе ${key} нет записей.` };

    const explicitHeaders = Array.isArray(args.headers) ? (args.headers as unknown[]).map(h => String(h)).filter(h => h.trim()) : [];
    let headers: string[]; let rows: unknown[][];
    if (Array.isArray(records[0])) {
      const n = (records[0] as unknown[]).length;
      headers = explicitHeaders.length === n ? explicitHeaders : Array.from({ length: n }, (_, i) => `Колонка ${i + 1}`);
      rows = records.map(r => (r as unknown[]).map(v => cellValue(v)));
    } else {
      const keys: string[] = [];
      for (const rec of records) {
        if (typeof rec !== 'object' || rec === null) continue;
        for (const k of Object.keys(rec as Record<string, unknown>)) if (!keys.includes(k)) keys.push(k);
      }
      headers = explicitHeaders.length > 0 ? explicitHeaders.filter(k => keys.includes(k)) : keys;
      rows = records.map((rec) => {
        const o = (typeof rec === 'object' && rec !== null) ? (rec as Record<string, unknown>) : {};
        return headers.map(h => cellValue(o[h]));
      });
    }
    if (headers.length === 0) return { ok: false, summary: '', error: `Не удалось определить колонки записей в ${key}.` };

    const sheetName = String(args.sheet_name || 'Данные').trim().slice(0, 31) || 'Данные';
    const title = String(args.file_name || '').trim() || 'records';
    const spec: Record<string, unknown> = {
      title,
      sheets: [{ name: sheetName, headers, rows, auto_filter: !!args.auto_filter, freeze_header: !!args.freeze_header, wrap: !!args.wrap }],
    };
    return generateFileTool('xlsx', spec, 'Excel');
  } catch (e: unknown) {
    return { ok: false, summary: '', error: errorMessage(e) };
  }
}

// ================= Реестр =================

export function createTools(): AgentTool[] {
  return [
    {
      schema: {
        name: 'create_docx',
        description: 'Сформировать документ Word (.docx): заголовок, разделы (абзацы и таблицы). По умолчанию документ оформляется по стандарту организации (Times New Roman 14pt, полуторный интервал, поля 30/10/20/20 мм, выравнивание по ширине, отступ первой строки 1,25 см, заголовки по центру, таблицы 10pt) — в spec это задавать НЕ нужно. Указывай только отличия: уровни заголовков (level 1–6), нестандартное выравнивание (align), жирный/курсив/подчёркнутый (bold/italic/underline), размер (size), выделение цветом (highlight), списки (list: bullet/number), стиль таблиц (style: grid/fancy), ширины колонок (col_widths), повтор шапки (repeat_header). Файл создаётся на сервере, возвращается ссылка на скачивание (~2 дня).',
        input_schema: { type: 'object', properties: { title: { type: 'string' }, sections: sectionsSchema }, required: ['title', 'sections'] },
      },
      execute: async (_ctx, args) => (!args.title || !args.sections)
        ? { ok: false, summary: '', error: 'Требуются поля title и sections.' }
        : generateFileTool('docx', args, 'Word'),
    },
    {
      schema: {
        name: 'create_xlsx',
        description: 'Сформировать таблицу Excel (.xlsx): листы с заголовками и строками. Поддерживается оформление: титульный ряд, автофильтр по колонкам (auto_filter), закрепление шапки (freeze_header), ширины колонок (col_widths), перенос текста (wrap). Возвращается ссылка на скачивание (~2 дня).',
        input_schema: { type: 'object', properties: { sheets: sheetsSchema }, required: ['sheets'] },
      },
      execute: async (_ctx, args) => (!args.sheets) ? { ok: false, summary: '', error: 'Требуется поле sheets.' } : generateFileTool('xlsx', args, 'Excel'),
    },
    {
      schema: {
        name: 'create_pdf',
        description: 'Сформировать электронный PDF: заголовок и разделы (абзацы, таблицы). Возвращается ссылка на скачивание (~2 дня).',
        input_schema: { type: 'object', properties: { title: { type: 'string' }, sections: sectionsSchema }, required: ['title', 'sections'] },
      },
      execute: async (_ctx, args) => (!args.title || !args.sections) ? { ok: false, summary: '', error: 'Требуются поля title и sections.' } : generateFileTool('pdf', args, 'PDF'),
    },
    {
      schema: {
        name: 'create_json',
        description: 'Сформировать JSON-файл с данными. Возвращается ссылка на скачивание (~2 дня).',
        input_schema: { type: 'object', properties: { data: { type: 'object', description: 'Данные для JSON-файла' } }, required: ['data'] },
      },
      execute: async (_ctx, args) => (args.data === undefined || args.data === null)
        ? { ok: false, summary: '', error: 'Требуется поле data.' }
        : generateFileTool('json', { data: args.data }, 'JSON'),
    },
    {
      schema: {
        name: 'parse_file',
        description: 'Прочитать прикреплённый пользователем файл (docx/xlsx/pdf/json) и извлечь его содержимое. Вызывается только если в последнем сообщении пользователя есть прикреплённый файл.',
        input_schema: { type: 'object', properties: { note: { type: 'string', description: 'Что именно нужно извлечь из файла' } } },
      },
      execute: async (_ctx, _args, attachment) => parseFileTool(attachment),
    },
    {
      schema: {
        name: 'get_emails',
        description: 'Поиск писем в базе почты (доступен, если у пользователя есть права на плагин «Письма»). Всегда напрямую из БД сервера. query — точное вхождение подстроки (без учёта регистра), НЕ семантический поиск — для русских слов ищи короткой основой без окончания (например «техническ», а не «техническое»), иначе форма слова в тексте не совпадёт. Пустой результат узкого запроса — НЕ доказательство, что нужной информации нет: если письма по более широкой теме уже получены в этом диалоге, сначала проверь их полный текст (поле text), прежде чем говорить пользователю, что информации нет.',
        input_schema: { type: 'object', properties: { query: { type: 'string' }, direction: { type: 'string' }, limit: { type: 'number', description: 'По умолчанию 20, максимум 200' } } },
      },
      execute: async (_ctx, args) => getEmailsTool(args),
    },
    {
      schema: {
        name: 'get_documents',
        description: 'Поиск документов в базе документов (доступен, если у пользователя есть права на плагин «Документы»). Всегда напрямую из БД сервера. У карточки может быть ЛИБО внешняя ссылка (link_url — например, файл в YouGile), ЛИБО загруженный в систему файл (тогда есть file_key, а link_url пусто) — это два РАЗНЫХ способа приложить файл, не «есть ссылка / нет файла». Если link_url пусто, но file_key заполнен — файл ЕСТЬ, просто нужно получить рабочую ссылку через get_document_link(file_key); НЕ говори пользователю, что файла нет или что нужно спрашивать куратора, пока не проверил именно так. query — точное вхождение подстроки (без учёта регистра) по всем текстовым полям, НЕ семантический поиск — для русских слов ищи короткой основой без окончания (например «техническ», а не «техническое»), иначе форма слова в тексте («техническая», «технического» и т.п.) не совпадёт и результат будет пустым, хотя нужное есть.',
        input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'По умолчанию 20, максимум 200' } } },
      },
      execute: async (_ctx, args) => getDocumentsTool(args),
    },
    {
      schema: {
        name: 'get_document_link',
        description: 'Получить временную ссылку на загруженный файл документа (presigned, действует ~7 дней). Передай file_key из карточки get_documents (доступно только когда там нет link_url, но есть file_key).',
        input_schema: { type: 'object', properties: { file_key: { type: 'string' } }, required: ['file_key'] },
      },
      execute: async (_ctx, args) => getDocumentLinkTool(args),
    },
    {
      schema: {
        name: 'get_contacts',
        description: 'Поиск контактов (доступен, если у пользователя есть права на плагин «Контакты»). Всегда напрямую из БД сервера. query — точное вхождение подстроки (без учёта регистра), НЕ семантический поиск — для русских слов ищи короткой основой без окончания.',
        input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'По умолчанию 20, максимум 200' } } },
      },
      execute: async (_ctx, args) => getContactsTool(args),
    },
    {
      schema: {
        name: 'get_lims_requests',
        description: 'Заявки на испытания из ЛИМС (доступен, если у пользователя есть права на плагин «Заявки на испытания»/«ЛИМС»). Возвращает title, result (итоговый результат испытания), compliance (вердикт: «Соответствует»/«Не соответствует»/«Не оценивается», пусто — не посчитан), статус, номера, created_at (дата регистрации/поступления), completed_at (дата завершения). ВСЕГДА фильтруй по lab/date_from/date_to, если пользователь называет лабораторию или период — НЕ выгружай все заявки без фильтра ради подсчёта вручную, это может достигать сотен записей и не поместится в контекст. Для ГРАФИКА/СТАТИСТИКИ поступления-завершения по датам ОБЯЗАТЕЛЬНО передавай group_by (day/week/month) ОДНИМ вызовом на весь период — тул сам посчитает количество по датам и вернёт готовые точки в data.series; НЕ дели период на части и НЕ пытайся посчитать вручную по сырым записям — это и есть причина таймаутов на больших выборках. Аналогично фильтруй по compliance, чтобы найти заявки с конкретным вердиктом.',
        input_schema: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'new/processing/completed' },
            compliance: { type: 'string', description: 'Точное совпадение: «Соответствует», «Не соответствует» или «Не оценивается»' },
            lab: { type: 'string', description: 'Название или код лаборатории (частичное совпадение, например «пожарных»)' },
            date_from: { type: 'string', description: 'Начало периода, YYYY-MM-DD. Заявка проходит, если в диапазон попадает дата регистрации ИЛИ дата завершения' },
            date_to: { type: 'string', description: 'Конец периода, YYYY-MM-DD' },
            group_by: { type: 'string', enum: ['day', 'week', 'month'], description: 'Для графика/статистики по датам: вернуть НЕ список заявок, а готовые счётчики поступления/завершения по периодам (data.series: [{period, arrived, completed}]). Всегда используй это вместо ручного подсчёта.' },
            limit: { type: 'number', description: 'По умолчанию 20, максимум 200 (после фильтров status/compliance/lab/date_from/date_to; игнорируется при group_by)' },
          },
        },
      },
      execute: async (_ctx, args) => getLimsRequestsTool(args),
    },
    {
      schema: {
        name: 'get_photos',
        description: 'Поиск фотографий в корпоративном фотобанке (доступен, если у пользователя есть права на плагин «Фотобанк»). Ищи по описанию/тегам/названию папки. Возвращает карточки: id, title, description, tags, folder_name, file_key и др. Если пользователь сам назвал id фото — передай его в поле id для точного поиска вместо query.',
        input_schema: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string', enum: ['image', 'video', 'raw'] }, limit: { type: 'number', description: 'По умолчанию 20, максимум 200' }, id: { type: 'number', description: 'Точный id фото, если пользователь явно его назвал — возвращает только эту карточку, query/kind игнорируются' } } },
      },
      execute: async (_ctx, args) => getPhotosTool(args),
    },
    {
      schema: {
        name: 'get_photo_link',
        description: 'Получить временную ссылку на файл фотобанка (presigned, действует ~7 дней). Передай file_key из карточки get_photos.',
        input_schema: { type: 'object', properties: { file_key: { type: 'string' } }, required: ['file_key'] },
      },
      execute: async (_ctx, args) => getPhotoLinkTool(args),
    },
    {
      schema: {
        name: 'get_yougile_tasks',
        description: 'Читает задачи YouGile (доступно, если у пользователя настроен пароль YouGile в настройках веб-портала). Возвращает сырые карточки задач YouGile (id, title, description, columnId, assigned, deadline и др.). Для «мои задачи» используй mine:true — НЕ ходи за списком пользователей ради этого. Для вопросов про объём/динамику задач по периодам и/или исполнителям используй get_yougile_task_stats, а не эту (нельзя пересчитывать вручную сотни карточек — это раздувает контекст и роняет следующий запрос к модели, живой инцидент 2026-09-06). Фильтруй по тексту через query (ищет по всем строковым полям) или по column_id/assigned_to, если уже знаешь id.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поиск по всем текстовым полям задачи (название, описание и т.п.)' },
            column_id: { type: 'string', description: 'id колонки YouGile (узнать через get_yougile_board_tree)' },
            assigned_to: { type: 'string', description: 'id исполнителя YouGile (узнать через get_yougile_board_tree)' },
            mine: { type: 'boolean', description: 'true — только задачи, назначенные текущему пользователю (сервер сам резолвит id по email, узнавать id заранее не нужно)' },
            limit: { type: 'number', description: 'По умолчанию 30, максимум 200' },
          },
        },
      },
      execute: async (_ctx, args) => getYougileTasksTool(args),
    },
    {
      schema: {
        name: 'get_yougile_task_stats',
        description: 'Счёт поступивших/завершённых задач YouGile по периодам (день/неделя/месяц) + готовая разбивка по исполнителям за диапазон дат — считает сервер по всем задачам компании, НЕ модель по сырым карточкам. Используй для любого вопроса про объём/динамику/нагрузку по задачам YouGile (в т.ч. для презентаций/графиков) вместо get_yougile_tasks с ручным подсчётом.',
        input_schema: {
          type: 'object',
          properties: {
            date_from: { type: 'string', description: 'Начало периода, YYYY-MM-DD' },
            date_to: { type: 'string', description: 'Конец периода, YYYY-MM-DD' },
            group_by: { type: 'string', enum: ['day', 'week', 'month'], description: 'Бакетирование точек графика' },
          },
          required: ['date_from', 'date_to', 'group_by'],
        },
      },
      execute: async (_ctx, args) => getYougileTaskStatsTool(args),
    },
    {
      schema: {
        name: 'get_yougile_board_tree',
        description: 'Справочники YouGile одним вызовом: проекты, доски, колонки, пользователи (id + название/email каждого). Вызывай перед create_yougile_task/set_yougile_task_status, чтобы сопоставить название доски/колонки/исполнителя, названное пользователем, с нужным id.',
        input_schema: { type: 'object', properties: {} },
      },
      execute: async () => getYougileBoardTreeTool(),
    },
    {
      schema: {
        name: 'create_yougile_task',
        description: 'Создать новую задачу в YouGile в указанной колонке. Сначала вызови get_yougile_board_tree, чтобы узнать column_id нужной доски/колонки (и id исполнителя, если пользователь назвал его по имени).',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Название задачи' },
            column_id: { type: 'string', description: 'id колонки YouGile, куда поместить задачу (из get_yougile_board_tree)' },
            description: { type: 'string', description: 'Описание задачи (необязательно)' },
            assigned: { type: 'array', items: { type: 'string' }, description: 'id исполнителей YouGile (необязательно, из get_yougile_board_tree)' },
          },
          required: ['title', 'column_id'],
        },
      },
      execute: async (_ctx, args) => createYougileTaskTool(args),
    },
    {
      schema: {
        name: 'set_yougile_task_status',
        description: 'Сменить статус задачи YouGile — в YouGile статус это колонка, к которой относится задача. Узнай column_id нужного статуса через get_yougile_board_tree.',
        input_schema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'id задачи (из get_yougile_tasks)' },
            column_id: { type: 'string', description: 'id колонки-статуса, куда перенести задачу (из get_yougile_board_tree)' },
          },
          required: ['task_id', 'column_id'],
        },
      },
      execute: async (_ctx, args) => setYougileTaskStatusTool(args),
    },
    {
      schema: {
        name: 'add_yougile_task_message',
        description: 'Добавить сообщение (и/или файл, если пользователь его прикрепил в чате) в чат конкретной задачи YouGile.',
        input_schema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'id задачи (из get_yougile_tasks)' },
            text: { type: 'string', description: 'Текст сообщения' },
          },
          required: ['task_id'],
        },
      },
      execute: async (_ctx, args, attachment) => addYougileTaskMessageTool(args, attachment),
    },
    {
      schema: {
        name: 'describe_api',
        description: 'Список read-only эндпоинтов, доступных через call_api (справочники ЛИМС — лаборатории/методы/проекты/объекты/группы/оборудование/испытатели, доп. срезы фотобанка и т.п.), помимо уже готовых get_*-тулов. Используй, когда нужных данных нет ни в одном get_*-туле — сначала посмотри список, потом вызывай call_api именно с тем path/app_id, что здесь показан.',
        input_schema: { type: 'object', properties: { app_id: { type: 'string', description: 'Ограничить список одним сервисом: lab/photo (пусто — показать все доступные)' } } },
      },
      execute: async (ctx, args) => describeApiTool(ctx, args),
    },
    {
      schema: {
        name: 'call_api',
        description: 'Вызвать один из эндпоинтов, показанных describe_api. Только чтение (GET), только эндпоинты из белого списка — произвольный путь не сработает.',
        input_schema: {
          type: 'object',
          properties: {
            app_id: { type: 'string', description: 'Как в describe_api, например lab/photo' },
            path: { type: 'string', description: 'Точно как в describe_api, например /api/lab/equipment/{id}/calibrations' },
            path_params: { type: 'object', description: 'Значения для {подстановок} в path, например {"id": 42}' },
            query: { type: 'object', description: 'Query-параметры, см. describe_api (например {"q":"..."} для поиска)' },
            limit: { type: 'number', description: 'Максимум элементов в массиве ответа, по умолчанию 50, максимум 200' },
          },
          required: ['app_id', 'path'],
        },
      },
      execute: async (ctx, args) => callApiTool(ctx, args),
    },
    {
      schema: {
        name: 'create_mermaid',
        description: 'Сформировать ПРОИЗВОЛЬНУЮ mermaid-диаграмму (graph TD/flowchart/sequenceDiagram и т.п. — не про числовые данные) по коду, который ты сам пишешь: PNG + SVG + .mmd исходник. НЕ используй для обычного графика по числам/датам (bar/line/pie, в т.ч. несколько рядов вроде «поступление/завершение») — для этого возьми create_png с chart, там нельзя написать невалидный синтаксис (код собирает сервер), а здесь можно, и ты уже так однажды ошибался (несуществующий оператор legend в xychart-beta).',
        input_schema: { type: 'object', properties: { title: { type: 'string' }, code: { type: 'string', description: 'Mermaid-код (graph TD/flowchart/sequenceDiagram и т.п.)' } }, required: ['title', 'code'] },
      },
      execute: async (_ctx, args) => (!args.title || !args.code) ? { ok: false, summary: '', error: 'Требуются поля title и code.' } : generateFileTool('mermaid', args, 'Mermaid (PNG)'),
    },
    {
      schema: {
        name: 'create_png',
        description: 'Сгенерировать PNG-график из данных — рендерится в браузере (никогда не пишешь mermaid-синтаксис вручную). Два варианта chart: (1) один ряд — {type, title, data:[{label,value}]} (для donut/pie — ровно этот вариант, один ряд); (2) НЕСКОЛЬКО рядов на общих категориях (например «поступление»/«завершение» по одним и тем же датам, как в data.series из get_lims_requests с group_by) — {title, categories:[подписи оси X], series:[{name, values:[числа]}]}. Категории — это ровно то, что должно быть подписью оси X: если пользователь просит «только день, без месяца» — передай в categories уже укороченные подписи («01», «02», …), а не полную дату. legend/x_label/y_label управляют внешним видом — если пользователь не уточнил, выбирай разумные значения сам (легенда нужна, если рядов/категорий больше одного; подписи осей — по смыслу данных) или спроси, если действительно неочевидно. Есть встроенная защита от бесконечного перегенерирования почти одинакового графика — если требуется всего лишь другая подпись оси X, это одна правка массива categories, не повод вызывать тул больше 2 раз с разным text/заголовком. Возвращается ссылка на скачивание PNG.',
        input_schema: {
          type: 'object',
          properties: {
            chart: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['bar', 'line', 'donut', 'pie', 'area', 'scatter'], description: 'Тип графика' },
                title: { type: 'string' },
                data: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } } }, description: 'Один ряд: массив {label, value} (обязателен для donut/pie)' },
                categories: { type: 'array', items: { type: 'string' }, description: 'Подписи оси X для нескольких рядов (см. series) — ровно то, что должно отображаться на графике' },
                series: {
                  type: 'array',
                  items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['values'] },
                  description: 'Несколько рядов на общих categories, каждый со своими values той же длины что categories',
                },
                legend: { type: 'boolean', description: 'Показывать легенду (по умолчанию true)' },
                x_label: { type: 'string', description: 'Подпись оси X (необязательно)' },
                y_label: { type: 'string', description: 'Подпись оси Y (необязательно, не применяется к donut/pie)' },
              },
            },
            mermaid: { type: 'string', description: 'Диаграмма по готовому mermaid-коду вместо chart — только если код уже есть (например, из create_mermaid), не для написания графика с нуля' },
          },
        },
      },
      execute: async (_ctx, args) => {
        if (!args.chart && !args.mermaid) return { ok: false, summary: '', error: 'Требуется chart или mermaid.' };
        if (args.chart) return renderChartTool(args.chart as Record<string, unknown>);
        return generateFileTool('png', { mermaid: args.mermaid }, 'PNG');
      },
    },
    {
      schema: {
        name: 'create_presentation',
        description: `Сформировать настоящую презентацию (слайды с полноэкранным показом, переходами, печатью в PDF) — НЕ плоский HTML-отчёт (для отчётов есть create_html, это другое). Игнорируй presentation-creator из list_skills/read_skill, если он попадётся — это скил про другой формат (React/Vite-сборка со стилем Sentry), к нашим презентациям отношения не имеет; для презентаций используй ИСКЛЮЧИТЕЛЬНО этот тул.

ПЕРЕД вызовом — презентация почти никогда не однозначна с одного сообщения.
Если пользователь не назвал явно целевую аудиторию и цель презентации
(информировать / отчитаться / убедить / запросить решение-ресурс —
это определяет структуру hook/context/…/ask ниже и вообще то, какие
данные считать важными) — проведи короткий брейнсторм ДО сбора данных
(см. скил brainstorming через list_skills/read_skill): по одному вопросу
за раз, начиная с аудитории и цели, пока не станет ясно, что показывать и
зачем — не пропускай этот шаг ради скорости. Если аудитория/цель и так
ясны из контекста диалога — не спрашивай заново.

Отдельно, уже перед самим вызовом тула — если не ясно (а) сколько примерно
слайдов нужно, (б) кого указывать докладчиком и какие его контакты показать
(телефон/email — для QR на финальном слайде), (в) нужен ли фон/фото на
титульный и шмуцтитульные слайды — задай ОДНИМ сообщением короткий
уточняющий вопрос по этим (более механическим) открытым пунктам. Можно
предложить разумное умолчание прямо в вопросе («за докладчика возьму вас —
верно?»), но не проставлять его молча — и НИКОГДА не бери логин/email
текущего пользователя как контакты докладчика без явного подтверждения.

Правка уже собранной в этом диалоге презентации (переименование, дата,
мелкая правка текста/состава одного слайда и т.п.) — это НЕ повод собирать
данные заново. У этого тула нет «частичного обновления» — единственный
способ внести правку технически — вызвать его снова целиком, НО это
означает взять ТЕ ЖЕ slides (включая уже готовые image_url графиков/фото
из своего предыдущего вызова этого тула в этом диалоге) и поменять только
то, о чём попросил пользователь. Заново вызывай get_yougile_task_stats/
get_lims_requests/create_png и т.п. ТОЛЬКО если правда нужны новые/другие
данные (другой период, другой график) — не «на всякий случай».

Дизайн-принципы (следуй им при написании содержимого слайдов):
${PRESENTATION_DESIGN_RULES}

Каждый слайд — объект с полем layout (обязательно) и полями по типу:
- title (титульный, первый слайд): heading1 (название доклада), subtitle (kicker), speaker (докладчик), image_url (фон, опционально).
- section (шмуцтитул раздела): heading1, heading2 (подзаголовок), image_url (фон половины слайда, опционально).
- bullets: heading1 (+heading2 вторая строка), bullets (массив строк), image_url (иллюстрация сбоку, опционально).
- cards: heading1, cards ([{title, body}]), image_url (опционально).
- table: heading1, table ({headers, rows}), image_url (опционально).
- photo: heading1, heading2, bullets, image_url (фон на весь слайд — для этого layout почти всегда нужен).
- final (обязательно последним слайдом): speaker (опционально — иначе возьмётся presenter) — шаблон сам добавит «Спасибо за внимание» и QR контакта докладчика, если заданы presenter_phone/presenter_email.

image_url — обычная ссылка (из get_photo_link по фото из Фотобанка, или ссылка, которую только что вернул create_png) — не data URI, не путь в вольте.`,
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Название презентации' },
            slides: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  layout: { type: 'string', enum: ['title', 'section', 'bullets', 'cards', 'table', 'photo', 'final'] },
                  heading1: { type: 'string' },
                  heading2: { type: 'string' },
                  subtitle: { type: 'string' },
                  bullets: { type: 'array', items: { type: 'string' } },
                  cards: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] } },
                  table: { type: 'object', properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } },
                  speaker: { type: 'string' },
                  footer: { type: 'string', description: 'Переопределить нижнюю подпись слайда (по умолчанию — дата · название доклада · номер)' },
                  image_url: { type: 'string', description: 'Ссылка на фото (get_photo_link) или график (create_png) для этого слайда' },
                  image_fit: { type: 'string', enum: ['cover', 'contain'], description: 'Как вписать image_url: "cover" — заполнить всю область, обрезая края (подходит для фото); "contain" — вписать целиком без обрезки (обязательно для графиков/диаграмм, где важны подписи осей и легенда по краям). По умолчанию "contain".' },
                },
                required: ['layout'],
              },
            },
            presenter: { type: 'string', description: 'Докладчик (для финального слайда, если у слайда не задан свой speaker) — реальное имя, названное/подтверждённое пользователем, не email/логин по умолчанию' },
            presenter_phone: { type: 'string', description: 'Телефон докладчика — для QR-контакта на финальном слайде (только если пользователь сам его назвал)' },
            presenter_email: { type: 'string', description: 'Email докладчика — для QR-контакта на финальном слайде (только если пользователь сам его назвал или подтвердил использование своего)' },
            date: { type: 'string', description: 'Дата доклада, для подписи слайдов (опционально)' },
          },
          required: ['title', 'slides'],
        },
      },
      execute: async (_ctx, args) => createPresentationTool(args),
    },
    {
      schema: {
        name: 'create_html',
        description: 'Сформировать самодостаточный HTML-файл: текст/разделы, встроенные base64-изображения (url — ссылка на PNG от create_png/create_mermaid), inline SVG и mermaid-диаграммы. Возвращается ссылка на скачивание HTML.',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } }, table: { type: 'object', properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } } } } },
            images: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, caption: { type: 'string' } } } },
            svgs: { type: 'array', items: { type: 'string' } },
            mermaid_blocks: { type: 'array', items: { type: 'string' } },
          },
          required: ['title'],
        },
      },
      execute: async (_ctx, args) => (!args.title) ? { ok: false, summary: '', error: 'Требуется title.' } : generateFileTool('html', args, 'HTML'),
    },
    {
      schema: {
        name: 'add_skill',
        description: 'Установить ГЛОБАЛЬНЫЙ скил (одобренный администратором). В веб-версии сработает только для уже глобально установленного скила.',
        input_schema: { type: 'object', properties: { repo_url: { type: 'string' }, skill_path: { type: 'string' } }, required: ['repo_url'] },
      },
      execute: async (_ctx, args) => addSkillTool(args),
    },
    {
      schema: { name: 'list_skills', description: 'Список глобальных скилов (имя и описание). Вызывай, когда задача похожа на известную методику.', input_schema: { type: 'object', properties: {} } },
      execute: async () => listSkillsTool(),
    },
    {
      schema: { name: 'read_skill', description: 'Загрузить инструкции глобального скила (SKILL.md) и содержимое всех его вспомогательных файлов (data.files[].content) в контекст.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
      execute: async (_ctx, args) => readSkillTool(args),
    },
    {
      schema: {
        name: 'read_text_part',
        description: 'Прочитать часть сохранённого текста большого документа (после parse_file). parse_file сообщает key и объём; вызывай read_text_part повторно с увеличивающимся start, пока не получишь «конец документа». Хранится 48 часов.',
        input_schema: { type: 'object', properties: { key: { type: 'string', description: 'Ключ сохранённого текста (из parse_file)' }, start: { type: 'number' }, length: { type: 'number', description: 'Максимум 24000, по умолчанию 24000' } }, required: ['key', 'start'] },
      },
      execute: async (_ctx, args) => readTextPartTool(args),
    },
    {
      schema: {
        name: 'save_rule',
        description: 'Создать или обновить файл правил по указанию пользователя. Сохранённые правила автоматически применяются агентом. append=true — дополнить существующий файл.',
        input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Например AGENTS.md или менеджмент.md. Пусто — правила.md' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['content'] },
      },
      execute: async (_ctx, args) => saveRuleTool(args),
    },
    {
      schema: { name: 'list_rules', description: 'Список файлов правил агента.', input_schema: { type: 'object', properties: {} } },
      execute: async () => listRulesTool(),
    },
    {
      schema: { name: 'read_rule', description: 'Прочитать файл правил в контекст.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      execute: async (_ctx, args) => readRuleTool(args),
    },
    {
      schema: {
        name: 'fetch_url',
        description: 'Скрытый серверный HTTP-запрос к сайту/API (быстро, без браузера). Подходит для страниц и JSON/API-эндпоинтов (в т.ч. DataTables). Для сбора списков постранично указывай save_to — короткое имя накопителя: записи (data) каждой страницы сохраняются сервером (48 часов), не проходя через контекст.',
        input_schema: {
          type: 'object',
          properties: {
            method: { type: 'string', description: 'GET (по умолчанию) / POST / PUT / PATCH / DELETE' },
            url: { type: 'string' },
            body: { type: 'string' },
            headers: { type: 'object' },
            timeout_ms: { type: 'number', description: 'По умолчанию 30000, максимум 120000' },
            save_to: { type: 'string', description: 'Короткое имя накопителя (например nsopb_reestr) — сервер вернёт key' },
          },
          required: ['url'],
        },
      },
      execute: async (_ctx, args) => fetchUrlTool(args),
    },
    {
      schema: {
        name: 'save_records',
        description: 'Сохранить (накопить) записи одной страницы на сервере (48 часов). Передай key (продолжение существующего накопителя) или name (новый). mode="overwrite" — начать заново.',
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Ключ существующего накопителя (из предыдущего вызова)' },
            name: { type: 'string', description: 'Имя нового накопителя (если key ещё нет)' },
            records: { type: 'array', description: 'Записи этой страницы' },
            mode: { type: 'string', enum: ['append', 'overwrite'] },
          },
          required: ['records'],
        },
      },
      execute: async (_ctx, args) => saveRecordsTool(args),
    },
    {
      schema: {
        name: 'build_xlsx_from_records',
        description: 'Собрать Excel-файл из накопленных записей (save_records/fetch_url save_to). Вызывай ПОСЛЕ того, как постранично собраны все записи.',
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Ключ накопителя' },
            file_name: { type: 'string' },
            sheet_name: { type: 'string' },
            headers: { type: 'array', items: { type: 'string' } },
            auto_filter: { type: 'boolean' },
            freeze_header: { type: 'boolean' },
            wrap: { type: 'boolean' },
          },
          required: ['key'],
        },
      },
      execute: async (_ctx, args) => buildXlsxFromRecordsTool(args),
    },
  ];
}
