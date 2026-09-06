/** Типы модуля LogicTEAM.007 (agent) — веб-версия. Зеркалит sbe-agent
 * (Obsidian-плагин) src/types/agent.ts, без частей, зависящих от вольта. */

/** 'summary' — сжатая история (см. AgentEngine.compactHistoryIfNeeded), не
 *  обычная реплика ассистента. */
export type AgentRole = 'user' | 'assistant' | 'tool' | 'summary';

export interface AgentMessageLink {
  url: string;
  label: string;
}

export interface AgentMessage {
  role: AgentRole;
  content: string;
  files?: string[];
  tool?: string;
  toolOk?: boolean;
  link?: AgentMessageLink;
  created_at: string;
}

export interface Dialog {
  id: string;
  title: string;
  messages: AgentMessage[];
  created_at: string;
  updated_at: string;
}

/** MCP-совместимое описание тула (JSON Schema для input_schema). */
export interface AgentToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Результат исполнения тула. summary — кратко для чата; data — полные данные LLM. */
export interface ToolCallResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
  link?: AgentMessageLink;
}

export interface FileGenerateResponse {
  url: string;
  expires_at: string;
  file_name: string;
  extra?: Record<string, string>;
}

export interface FileParseResponse {
  kind: string;
  text?: string;
  sheets?: Array<{ name: string; rows: unknown[][] }>;
  data?: unknown;
}

export type LlmTurn =
  | { type: 'final'; text: string }
  | { type: 'tool_call'; tool: string; arguments: Record<string, unknown> };

export interface SourceAvailability {
  appId: string;
  name: string;
  available: boolean;
  role: string;
}

export interface AgentRule {
  path: string;
  content: string;
}

export interface GlobalSkillLite {
  name: string;
  description: string;
}

export interface GlobalSkillFile {
  name: string;
  content: string;
}

export interface GlobalSkill extends GlobalSkillLite {
  content: string;
  files: GlobalSkillFile[];
}

/** Модель провайдера LLM (цены + флаг устаревшей модели), из GET /api/llm/models. */
export interface LlmModel {
  id: string;
  owned_by: string;
  input_cost_per_million_tokens: string | null;
  output_cost_per_million_tokens: string | null;
  is_old_model: boolean;
}
