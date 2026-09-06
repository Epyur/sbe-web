import type { Dialog, AgentMessage, LlmTurn } from '../../types/agent';
import type { AgentTool, AgentToolContext, AgentAttachment } from './tools';
import { loadAllRules } from './tools';
import { SYSTEM_PROMPT_TEMPLATE, renderSystemPrompt } from './systemPrompt';
import * as agentApi from '../../api/agentApi';
import * as llmApi from '../../api/llmApi';
import { errorMessage, AbortedByUserError } from '../../api/http';

/**
 * Порт sbe-agent/src/agent/agent-engine.ts. Отличия от Obsidian-версии:
 * - системный промпт берётся из agentApi.getSystemPrompt() (per-user запись в
 *   agent-service), не из заметки вольта;
 * - правила — loadAllRules() из tools.ts (agentApi.getRules(), не файлы вольта),
 *   кэшируются на весь диалог (не перезапрашиваются на каждой итерации, как
 *   было в Obsidian — там это файлы вольта, здесь HTTP);
 * - LLM-клиент — llmApi.complete (порт SbeLlmApi.complete).
 */

const DEFAULT_MAX_ITERATIONS = 15;

/** Кап на JSON одного результата тула, отправляемый модели В ТЕКУЩЕМ ходу
 * (см. summaryForLlm). При превышении — честный отказ, не обрезка посередине
 * JSON (была живая жалоба 2026-09-06, см. docs/superpowers/specs/
 * 2026-09-06-web-agent-context-compaction-design.md). */
const MAX_TOOL_DATA_CHARS = 30000;

/** Порог суммарной длины истории диалога (символы), при превышении которого
 * AgentEngine сжимает старую часть в дайджест перед новым ходом. */
const HISTORY_COMPACT_THRESHOLD_CHARS = 50000;

/** Сколько последних сообщений всегда остаются несжатыми (ближайший контекст). */
const HISTORY_KEEP_RECENT = 8;

const COMPACTION_SYSTEM_PROMPT = [
  'Сожми историю диалога агента в компактный структурированный дайджест на русском.',
  'ОБЯЗАТЕЛЬНО сохрани ВСЕ числа, id, даты, названия и принятые решения — списком',
  'или таблицей, не прозой. Не выдумывай ничего, чего нет в истории.',
  'Если в начале истории уже есть дайджест прошлого сжатия (помечен как',
  '"[Свёрнутая история]") — ОБНОВИ его, не потеряв ни одного факта из него,',
  'и добавь факты из новых сообщений. Верни ТОЛЬКО текст дайджеста, без пояснений.',
].join(' ');

/** Идемпотентные тулы (нет в веб-версии — browser_* не перенесены), оставлено
 * пустым намеренно: fetch_url НЕ идемпотентен (повтор — зацикливание). */
const IDEMPOTENT_TOOLS = new Set<string>([]);

/** Структурная защита от «блуждания»: сколько раз подряд можно вызвать ОДИН И
 * ТОТ ЖЕ инструмент (с ЛЮБЫМИ аргументами) прежде чем принудительно остановить
 * ход и попросить пользователя уточнить задачу. В отличие от seenCalls (ловит
 * повтор с ИДЕНТИЧНЫМИ аргументами), это ловит перебор разных запросов одним и
 * тем же тулом — живой инцидент 2026-09-06: агент 10+ раз подряд менял поисковый
 * запрос к фотобанку («обложка», «фото», …) вместо того чтобы остановиться и
 * спросить пользователя, и упёрся в общий лимит шагов без внятного сообщения. */
const CONSECUTIVE_SAME_TOOL_LIMIT = 5;

export interface RunAgentParams {
  dialog: Dialog;
  userMessage: string;
  attachment: AgentAttachment | null;
  model?: string;
  onToolResult: (message: AgentMessage) => void;
  onAssistant: (text: string) => void;
  onProgress: (status: string) => void;
}

export class AgentEngine {
  private tools: AgentTool[];
  private ctx: AgentToolContext;
  private maxIterations: number;
  private rulesBlock: string | null = null;
  private abortController: AbortController | null = null;

  constructor(tools: AgentTool[], ctx: AgentToolContext, maxIterations = DEFAULT_MAX_ITERATIONS) {
    this.tools = tools;
    this.ctx = ctx;
    this.maxIterations = maxIterations;
  }

  /** Остановить текущий run() (например, по Esc/кнопке «Стоп») — прерывает
   * запрос к LLM в процессе (включая ожидание между ретраями) и не даёт начать
   * следующую итерацию цикла. Безопасно вызывать и когда run() не выполняется. */
  stop(): void {
    this.abortController?.abort();
  }

  private async buildSystemPrompt(): Promise<string> {
    let template = SYSTEM_PROMPT_TEMPLATE;
    try {
      const override = await agentApi.getSystemPrompt();
      if (override && override.trim()) template = override;
    } catch (e: unknown) {
      console.warn('LogicTEAM.007: не удалось загрузить системный промпт, использую встроенный:', errorMessage(e));
    }
    return renderSystemPrompt(template, this.ctx, this.tools) + await this.buildRulesBlock();
  }

  /** Правила пользователя — один запрос на весь диалог (кэш в this.rulesBlock),
   * не на каждую итерацию цикла (в Obsidian это чтение локальных файлов вольта
   * и было бесплатным на каждый шаг; здесь — сетевой запрос). */
  private async buildRulesBlock(): Promise<string> {
    if (this.rulesBlock === null) {
      const rules = await loadAllRules();
      this.rulesBlock = rules ? `\n\nПравила пользователя (обязательны к исполнению):\n${rules}` : '';
    }
    return this.rulesBlock;
  }

  private serializeHistory(dialog: Dialog): string {
    const lines: string[] = [];
    for (const m of dialog.messages) {
      if (m.role === 'user') {
        const files = m.files?.length ? ` (прикреплён файл: ${m.files.join(', ')})` : '';
        lines.push(`[Пользователь] ${m.content}${files}`);
      } else if (m.role === 'assistant') {
        lines.push(`[Ассистент] ${m.content}`);
      } else if (m.role === 'tool') {
        lines.push(`[Результат тула ${m.tool || ''} (${m.toolOk ? 'ok' : 'ошибка'})] ${m.content.slice(0, 15000)}`);
      } else if (m.role === 'summary') {
        lines.push(`[Свёрнутая история] ${m.content}`);
      }
    }
    lines.push('');
    lines.push('Твой ход (только JSON):');
    return lines.join('\n');
  }

  /** Сжимает старую часть истории в дайджест, если суммарная длина превысила
   * порог — иначе не трогает dialog.messages. Последние HISTORY_KEEP_RECENT
   * сообщений всегда остаются как есть. При сбое сжатия (ошибка LLM) — тихо
   * пропускает, run() продолжает с полной историей. */
  private async compactHistoryIfNeeded(dialog: Dialog): Promise<void> {
    const totalLength = dialog.messages.reduce((sum, m) => sum + m.content.length, 0);
    if (totalLength <= HISTORY_COMPACT_THRESHOLD_CHARS || dialog.messages.length <= HISTORY_KEEP_RECENT) {
      return;
    }
    const older = dialog.messages.slice(0, -HISTORY_KEEP_RECENT);
    const recent = dialog.messages.slice(-HISTORY_KEEP_RECENT);
    const oldPart = this.serializeHistory({ ...dialog, messages: older })
      .replace(/\n\nТвой ход \(только JSON\):$/, '');
    try {
      const digest = await llmApi.complete(COMPACTION_SYSTEM_PROMPT, oldPart);
      const digestText = digest.trim();
      if (!digestText) return;
      dialog.messages = [
        { role: 'summary', content: digestText, created_at: new Date().toISOString() },
        ...recent,
      ];
      await agentApi.saveDialog(dialog);
    } catch (e: unknown) {
      console.warn('LogicTEAM.007: не удалось сжать историю диалога, продолжаю с полной:', errorMessage(e));
    }
  }

  private findTool(name: string): AgentTool | undefined {
    return this.tools.find(t => t.schema.name === name);
  }

  async run(params: RunAgentParams): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    const system = await this.buildSystemPrompt();
    await this.compactHistoryIfNeeded(params.dialog);
    let transcript = this.serializeHistory(params.dialog);
    const seenCalls = new Map<string, number>();
    let lastToolName: string | null = null;
    let consecutiveToolCount = 0;

    for (let i = 0; i < this.maxIterations; i++) {
      if (controller.signal.aborted) {
        params.onAssistant('Остановлено пользователем.');
        return;
      }
      params.onProgress('Агент думает…');
      let turns: LlmTurn[];
      try {
        const raw = await llmApi.complete(system, transcript, params.model ? { model: params.model } : undefined, controller.signal);
        turns = this.parseTurns(raw);
      } catch (e: unknown) {
        if (e instanceof AbortedByUserError) {
          params.onAssistant('Остановлено пользователем.');
          return;
        }
        params.onAssistant(`Ошибка обращения к LLM: ${errorMessage(e)}`);
        return;
      }

      for (const turn of turns) {
        if (controller.signal.aborted) {
          params.onAssistant('Остановлено пользователем.');
          return;
        }
        if (turn.type === 'final') {
          params.onAssistant(turn.text || 'Готово.');
          return;
        }

        params.onProgress(`Вызываю инструмент «${turn.tool || '…'}»…`);
        const tool = this.findTool(turn.tool || '');
        if (!tool) {
          params.onToolResult(this.toolMessage(turn.tool || '?', false, `Неизвестный инструмент «${turn.tool}»`));
          transcript += `\n[Результат тула ${turn.tool} (ошибка)] Неизвестный инструмент\nТвой ход (только JSON):`;
          continue;
        }

        const callKey = `${turn.tool}:${JSON.stringify(turn.arguments || {})}`;
        const count = (seenCalls.get(callKey) || 0) + 1;
        seenCalls.set(callKey, count);
        if (!IDEMPOTENT_TOOLS.has(turn.tool) && count > 2) {
          params.onAssistant(`Защита от зацикливания: инструмент «${turn.tool}» вызван одинаково ${count} раз. Измените параметры или уточните задачу.`);
          return;
        }

        if (turn.tool === lastToolName) {
          consecutiveToolCount++;
        } else {
          lastToolName = turn.tool;
          consecutiveToolCount = 1;
        }
        if (!IDEMPOTENT_TOOLS.has(turn.tool) && consecutiveToolCount > CONSECUTIVE_SAME_TOOL_LIMIT) {
          params.onAssistant(`Не получилось подобрать нужный результат: инструмент «${turn.tool}» вызван ${consecutiveToolCount} раз подряд с разными параметрами. Уточните, пожалуйста, задачу — что именно нужно найти или построить?`);
          return;
        }

        const result = await tool.execute(this.ctx, turn.arguments || {}, params.attachment);
        params.onToolResult(this.toolMessage(turn.tool, result.ok, result.ok ? result.summary : (result.error || 'ошибка'), result.link));

        transcript += `\n${result.ok
          ? `[Результат тула ${turn.tool} (ok)] ${this.summaryForLlm(result.summary, result.data)}`
          : `[Результат тула ${turn.tool} (ошибка)] ${result.error || 'ошибка'}`}\nТвой ход (только JSON):`;
      }
    }

    params.onAssistant(`Превышено число шагов агента (${this.maxIterations}). Попробуйте сформулировать задачу более конкретно.`);
  }

  /** Ленивый разбор хода LLM: все подряд идущие JSON-объекты (tool_call/final) +
   * обычный текст как финальный ответ, если JSON не найден. */
  private parseTurns(text: string): LlmTurn[] {
    const turns: LlmTurn[] = [];
    let rest = text.trim();
    const fence = rest.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) rest = fence[1].trim();

    while (true) {
      const start = rest.indexOf('{');
      if (start === -1) break;
      let depth = 0; let inStr = false; let esc = false; let objEnd = -1;
      for (let i = start; i < rest.length; i++) {
        const ch = rest[i];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { objEnd = i; break; } }
      }
      if (objEnd === -1) break;
      const objStr = rest.substring(start, objEnd + 1);
      rest = rest.slice(objEnd + 1);

      let parsed: unknown;
      try { parsed = JSON.parse(objStr); } catch { continue; }
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (obj.type === 'final') {
          turns.push({ type: 'final', text: typeof obj.text === 'string' ? obj.text : '' });
          return turns;
        }
        if (obj.type === 'tool_call') {
          turns.push({
            type: 'tool_call',
            tool: typeof obj.tool === 'string' ? obj.tool : '',
            arguments: obj.arguments && typeof obj.arguments === 'object' ? (obj.arguments as Record<string, unknown>) : {},
          });
          continue;
        }
        if (typeof (obj as { text?: unknown }).text === 'string') {
          turns.push({ type: 'final', text: (obj as { text: string }).text });
          return turns;
        }
      }
    }

    if (turns.length === 0) turns.push({ type: 'final', text: text.trim() });
    return turns;
  }

  private toolMessage(tool: string, ok: boolean, content: string, link?: { url: string; label: string }): AgentMessage {
    return { role: 'tool', tool, toolOk: ok, content, link, created_at: new Date().toISOString() };
  }

  private summaryForLlm(summary: string, data?: unknown): string {
    if (data === undefined) return summary || '';
    let json = '';
    try {
      json = JSON.stringify(data);
    } catch { json = String(data); }
    if (json.length > MAX_TOOL_DATA_CHARS) {
      return `${summary}\nДанные слишком большие (${json.length} символов, лимит ${MAX_TOOL_DATA_CHARS}) — не показаны. Уточни фильтр/лимит или используй агрегирующий тул, если он есть.`;
    }
    return `${summary}\nДанные: ${json}`;
  }
}
