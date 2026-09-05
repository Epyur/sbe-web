import type { AgentToolSchema, ToolCallResult, SourceAvailability, FileGenerateResponse, FileParseResponse } from '../../types/agent';
import { errorMessage } from '../../api/http';
import * as agentApi from '../../api/agentApi';

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
      file_name: i.file_name, link_url: i.link_url, parent_id: i.parent_id, completed: i.completed, updated_at: i.updated_at,
    }));
    return { ok: true, summary: `Документы (источник: server): найдено ${items.length}, показано ${picked.length}.`, data: { source: 'server', total: items.length, items: picked } };
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

async function getLimsRequestsTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    const status = String(args.status || '').trim();
    const compliance = String(args.compliance || '').trim();
    const limit = Number(args.limit) || 20;
    let items = await agentApi.getLimsRequests();
    if (status) items = items.filter(i => str(i.status).toLowerCase() === status.toLowerCase());
    if (compliance) items = items.filter(i => str(i.compliance).toLowerCase() === compliance.toLowerCase());
    const picked = limitItems(items, limit).map(i => ({
      id: i.id, title: i.title, customer_number: i.customer_number, lab_number: i.lab_number,
      status: i.status, result: i.result, compliance: i.compliance,
      owner_email: i.owner_email, updated_at: i.updated_at, completed_at: i.completed_at,
    }));
    return { ok: true, summary: `Заявки ЛИМС (источник: server): найдено ${items.length}, показано ${picked.length}.`, data: { source: 'server', total: items.length, items: picked } };
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
    let items = await agentApi.getPhotos();
    if (kind) items = items.filter(i => str(i.kind).toLowerCase() === kind.toLowerCase());
    if (query) {
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
    const files = g.files.map(f => f.name);
    return { ok: true, summary: `Глобальный скил «${g.name}» загружен. Следуй его инструкциям.`, data: { name: g.name, skill_md: g.content, files } };
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
        description: 'Поиск писем в базе почты (доступен, если у пользователя есть права на плагин «Письма»). Всегда напрямую из БД сервера.',
        input_schema: { type: 'object', properties: { query: { type: 'string' }, direction: { type: 'string' }, limit: { type: 'number', description: 'По умолчанию 20, максимум 200' } } },
      },
      execute: async (_ctx, args) => getEmailsTool(args),
    },
    {
      schema: {
        name: 'get_documents',
        description: 'Поиск документов в базе документов (доступен, если у пользователя есть права на плагин «Документы»). Всегда напрямую из БД сервера.',
        input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'По умолчанию 20, максимум 200' } } },
      },
      execute: async (_ctx, args) => getDocumentsTool(args),
    },
    {
      schema: {
        name: 'get_contacts',
        description: 'Поиск контактов (доступен, если у пользователя есть права на плагин «Контакты»). Всегда напрямую из БД сервера.',
        input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'По умолчанию 20, максимум 200' } } },
      },
      execute: async (_ctx, args) => getContactsTool(args),
    },
    {
      schema: {
        name: 'get_lims_requests',
        description: 'Заявки на испытания из ЛИМС (доступен, если у пользователя есть права на плагин «Заявки на испытания»/«ЛИМС»). Возвращает title, result (итоговый результат испытания), compliance (вердикт: «Соответствует»/«Не соответствует»/«Не оценивается», пусто — не посчитан), статус, номера. Фильтруй по compliance, чтобы найти заявки с конкретным вердиктом (например «Не соответствует»), а не листай все заявки вручную.',
        input_schema: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'new/processing/completed' },
            compliance: { type: 'string', description: 'Точное совпадение: «Соответствует», «Не соответствует» или «Не оценивается»' },
            limit: { type: 'number', description: 'По умолчанию 20, максимум 200 (после фильтра по status/compliance)' },
          },
        },
      },
      execute: async (_ctx, args) => getLimsRequestsTool(args),
    },
    {
      schema: {
        name: 'get_photos',
        description: 'Поиск фотографий в корпоративном фотобанке (доступен, если у пользователя есть права на плагин «Фотобанк»). Ищи по описанию/тегам/названию папки. Возвращает карточки: title, description, tags, folder_name, file_key и др.',
        input_schema: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string', enum: ['image', 'video', 'raw'] }, limit: { type: 'number', description: 'По умолчанию 20, максимум 200' } } },
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
        name: 'create_mermaid',
        description: 'Сформировать mermaid-диаграмму: PNG + SVG + .mmd исходник. Возвращаются ссылки на скачивание.',
        input_schema: { type: 'object', properties: { title: { type: 'string' }, code: { type: 'string', description: 'Mermaid-код (graph TD/flowchart/sequenceDiagram/pie/xychart-beta и т.п.)' } }, required: ['title', 'code'] },
      },
      execute: async (_ctx, args) => (!args.title || !args.code) ? { ok: false, summary: '', error: 'Требуются поля title и code.' } : generateFileTool('mermaid', args, 'Mermaid (PNG)'),
    },
    {
      schema: {
        name: 'create_png',
        description: 'Сгенерировать PNG: график из данных (chart: bar/line/pie) ИЛИ диаграмма по mermaid-коду (mermaid). Возвращается ссылка на скачивание PNG.',
        input_schema: {
          type: 'object',
          properties: {
            chart: { type: 'object', properties: { type: { type: 'string', enum: ['bar', 'line', 'pie'] }, title: { type: 'string' }, data: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } } } } } },
            mermaid: { type: 'string' },
          },
        },
      },
      execute: async (_ctx, args) => {
        if (!args.chart && !args.mermaid) return { ok: false, summary: '', error: 'Требуется chart или mermaid.' };
        return generateFileTool('png', args.chart ? { chart: args.chart } : { mermaid: args.mermaid }, 'PNG');
      },
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
      schema: { name: 'read_skill', description: 'Загрузить инструкции глобального скила (SKILL.md) в контекст.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
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
