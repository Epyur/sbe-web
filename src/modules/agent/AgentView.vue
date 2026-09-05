<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as agentApi from '../../api/agentApi';
import * as llmApi from '../../api/llmApi';
import { errorMessage } from '../../api/http';
import { sessionState } from '../../store/session';
import { useCollapsed } from '../../composables/useCollapsed';
import { AgentEngine } from './agentEngine';
import { createTools } from './tools';
import type { AgentToolContext, AgentAttachment } from './tools';
import type { Dialog, AgentMessage, SourceAvailability, LlmModel, AgentRule } from '../../types/agent';

const route = useRoute();
const router = useRouter();
const { collapsed, toggle } = useCollapsed('sw_sidebar_collapsed_agent');

const SELECTED_MODEL_KEY = 'sw_agent_selected_model';

const loading = ref(true);
const error = ref('');
const dialogs = ref<Dialog[]>([]);
const models = ref<LlmModel[]>([]);
const selectedModel = ref('');
const sources = ref<SourceAvailability[]>([]);

// Модель нужно выбирать явно и запоминать выбор (per-viewer, localStorage) —
// без этого пользователь каждый раз видел неявный "Модель по умолчанию" и не
// понимал, какая модель реально используется; без выбранной модели запрос к
// LLM тоже падал с непонятной ошибкой.
watch(selectedModel, (id) => {
  if (!id) return;
  try {
    localStorage.setItem(SELECTED_MODEL_KEY, id);
  } catch {
    // localStorage недоступен — выбор не переживёт перезагрузку
  }
});

const activeDialogId = computed(() => (route.params.dialogId as string) || '');
const activeDialog = computed<Dialog | null>(() => dialogs.value.find(d => d.id === activeDialogId.value) || null);

const inputText = ref('');
const attachedFile = ref<File | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const sending = ref(false);
const progressStatus = ref('');

const messagesEl = ref<HTMLElement | null>(null);

function scrollToBottom(): void {
  void nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  });
}

const showSettings = ref(false);
const systemPromptText = ref('');
const systemPromptSaved = ref(''); // пусто — используется дефолт
const rules = ref<AgentRule[]>([]);
const newRulePath = ref('');
const newRuleContent = ref('');
const settingsBusy = ref(false);
const settingsNotice = ref('');

const SOURCE_DEFS: Array<{ appId: string; name: string }> = [
  { appId: 'mailer', name: 'Письма' },
  { appId: 'documents', name: 'Документы' },
  { appId: 'contacts', name: 'Контакты' },
  { appId: 'lab', name: 'ЛИМС' },
  { appId: 'photo', name: 'Фотобанк' },
];

async function refreshSources(): Promise<void> {
  const list: SourceAvailability[] = [];
  for (const def of SOURCE_DEFS) {
    try {
      const me = await agentApi.getMyPermission(def.appId);
      list.push({ appId: def.appId, name: def.name, available: !!me.hasAccess, role: me.role || '' });
    } catch {
      list.push({ appId: def.appId, name: def.name, available: false, role: '' });
    }
  }
  sources.value = list;
}

// Последовательная очередь сохранений диалога — чтобы конкурентные вызовы
// agentApi.saveDialog (из onToolResult/onAssistant цикла агента) не перезаписали
// друг друга в неверном порядке при неодинаковой сетевой задержке.
let persistChain: Promise<void> = Promise.resolve();
function persistDialog(dialog: Dialog): void {
  dialog.updated_at = new Date().toISOString();
  persistChain = persistChain.then(() => agentApi.saveDialog(dialog)).catch((e: unknown) => {
    console.warn('LogicTEAM.007: не удалось сохранить диалог:', errorMessage(e));
  });
}

async function loadAll(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [history, modelList] = await Promise.all([
      agentApi.getChatHistory(),
      llmApi.listModels().catch(() => [] as LlmModel[]),
    ]);
    dialogs.value = history;
    models.value = modelList;
    if (modelList.length > 0) {
      let saved = '';
      try { saved = localStorage.getItem(SELECTED_MODEL_KEY) || ''; } catch { /* недоступен */ }
      selectedModel.value = modelList.some(m => m.id === saved) ? saved : modelList[0].id;
    }
    await refreshSources();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(loadAll);

function openDialog(id: string): void {
  router.push({ name: 'agent', params: { dialogId: id } });
}

function makeDialog(title: string): Dialog {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: title.slice(0, 60) || 'Новый диалог',
    messages: [],
    created_at: now,
    updated_at: now,
  };
}

function newDialog(): void {
  const dialog = makeDialog('Новый диалог');
  dialogs.value.unshift(dialog);
  openDialog(dialog.id);
}

async function removeDialog(id: string): Promise<void> {
  try {
    await agentApi.deleteDialog(id);
    dialogs.value = dialogs.value.filter(d => d.id !== id);
    if (activeDialogId.value === id) router.push({ name: 'agent' });
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}

function onFileChange(e: Event): void {
  const target = e.target as HTMLInputElement;
  attachedFile.value = target.files && target.files.length > 0 ? target.files[0] : null;
}

function clearAttachment(): void {
  attachedFile.value = null;
  if (fileInput.value) fileInput.value.value = '';
}

function buildContext(): AgentToolContext {
  return {
    getEmail: () => sessionState.session?.email ?? '',
    getUserName: () => sessionState.session?.email ?? '',
    getSources: () => sources.value,
  };
}

async function sendMessage(): Promise<void> {
  const text = inputText.value.trim();
  if (!text || sending.value) return;

  let dialog = activeDialog.value;
  if (!dialog) {
    dialog = makeDialog(text);
    dialogs.value.unshift(dialog);
    router.replace({ name: 'agent', params: { dialogId: dialog.id } });
  }

  const file = attachedFile.value;
  let attachment: AgentAttachment | null = null;
  if (file) {
    attachment = { name: file.name, data: await file.arrayBuffer() };
  }

  const userMessage: AgentMessage = {
    role: 'user',
    content: text,
    files: file ? [file.name] : undefined,
    created_at: new Date().toISOString(),
  };
  dialog.messages.push(userMessage);
  persistDialog(dialog);

  inputText.value = '';
  clearAttachment();
  sending.value = true;
  progressStatus.value = 'Агент думает…';

  const engine = new AgentEngine(createTools(), buildContext());
  const currentDialog = dialog;
  try {
    await engine.run({
      dialog: currentDialog,
      userMessage: text,
      attachment,
      model: selectedModel.value || undefined,
      onToolResult: (message) => {
        currentDialog.messages.push(message);
        persistDialog(currentDialog);
      },
      onAssistant: (msgText) => {
        currentDialog.messages.push({ role: 'assistant', content: msgText, created_at: new Date().toISOString() });
        persistDialog(currentDialog);
      },
      onProgress: (status) => { progressStatus.value = status; },
    });
  } catch (e: unknown) {
    currentDialog.messages.push({ role: 'assistant', content: `Ошибка агента: ${errorMessage(e)}`, created_at: new Date().toISOString() });
    persistDialog(currentDialog);
  } finally {
    sending.value = false;
    progressStatus.value = '';
  }
}

// ================= Настройки: системный промпт + правила =================

async function openSettings(): Promise<void> {
  showSettings.value = true;
  settingsNotice.value = '';
  try {
    const [prompt, ruleList] = await Promise.all([agentApi.getSystemPrompt(), agentApi.getRules()]);
    systemPromptSaved.value = prompt;
    systemPromptText.value = prompt;
    rules.value = ruleList;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}

async function saveSystemPrompt(): Promise<void> {
  settingsBusy.value = true;
  settingsNotice.value = '';
  try {
    await agentApi.saveSystemPrompt(systemPromptText.value);
    systemPromptSaved.value = systemPromptText.value;
    settingsNotice.value = 'Системный промпт сохранён';
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    settingsBusy.value = false;
  }
}

async function resetSystemPrompt(): Promise<void> {
  settingsBusy.value = true;
  settingsNotice.value = '';
  try {
    await agentApi.resetSystemPrompt();
    systemPromptText.value = '';
    systemPromptSaved.value = '';
    settingsNotice.value = 'Сброшено на дефолт';
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    settingsBusy.value = false;
  }
}

async function addRule(): Promise<void> {
  if (!newRuleContent.value.trim()) return;
  settingsBusy.value = true;
  try {
    await agentApi.saveRule(newRulePath.value.trim() || 'правила.md', newRuleContent.value.trim());
    rules.value = await agentApi.getRules();
    newRulePath.value = '';
    newRuleContent.value = '';
    settingsNotice.value = 'Правило сохранено';
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    settingsBusy.value = false;
  }
}

async function removeRule(path: string): Promise<void> {
  settingsBusy.value = true;
  try {
    await agentApi.deleteRule(path);
    rules.value = rules.value.filter(r => r.path !== path);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    settingsBusy.value = false;
  }
}

function toggleSettings(): void {
  if (showSettings.value) {
    showSettings.value = false;
    return;
  }
  void openSettings();
}

function modelLabel(m: LlmModel): string {
  // Валюта цены не подтверждена (chadgpt.ru — российский сервис, вероятно ₽,
  // не $) — показываем число без символа валюты, чтобы не утверждать неверное.
  const price = m.input_cost_per_million_tokens ? ` · ${m.input_cost_per_million_tokens}/1М вх.` : '';
  const old = m.is_old_model ? ' (устар.)' : '';
  return `${m.id}${price}${old}`;
}

watch(activeDialogId, () => {
  showSettings.value = false;
  scrollToBottom();
});

watch(() => activeDialog.value?.messages.length, scrollToBottom);
</script>

<template>
  <div class="sw-layout">
    <aside class="sw-sidebar" :class="{ 'is-collapsed': collapsed }" style="display: flex; flex-direction: column; overflow-y: hidden">
      <button class="sw-sidebar__toggle" type="button" :title="collapsed ? 'Развернуть' : 'Свернуть'" @click="toggle">{{ collapsed ? '»' : '«' }}</button>
      <template v-if="!collapsed">
        <div style="flex: 1; min-height: 0; overflow-y: auto">
          <button class="sw-btn sw-btn--primary" type="button" style="width: 100%; margin-bottom: 10px" @click="newDialog">+ Новый диалог</button>
          <div class="sw-tree">
            <div
              v-for="d in dialogs"
              :key="d.id"
              class="sw-tree__item"
              :class="{ 'sw-tree__item--active': d.id === activeDialogId }"
              style="display: flex; align-items: center; gap: 6px"
            >
              <span style="flex: 1; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" @click="openDialog(d.id)">{{ d.title }}</span>
              <button class="sw-btn sw-btn--ghost" type="button" title="Удалить" @click="removeDialog(d.id)">🗑</button>
            </div>
            <p v-if="dialogs.length === 0" class="sw-hint">Диалогов пока нет</p>
          </div>
          <div class="sw-section-title">Источники</div>
          <ul style="list-style: none; padding: 0; font-size: 13px; margin: 0">
            <li v-for="s in sources" :key="s.appId" :class="s.available ? '' : 'sw-hint'">
              {{ s.name }}{{ s.available ? (s.role ? ` (${s.role})` : '') : ' — нет доступа' }}
            </li>
          </ul>
        </div>
        <button class="sw-btn" type="button" style="width: 100%; flex-shrink: 0; margin-top: 10px" @click="toggleSettings">⚙ Настройки агента</button>
      </template>
    </aside>

    <main class="sw-content sw-agent-page">
      <div class="sw-agent-header">
        <h2 style="margin: 0 0 8px">LogicTEAM.007</h2>
        <p v-if="error" class="sw-error">{{ error }}</p>
      </div>
      <p v-if="loading" class="sw-loading">Загрузка…</p>

      <template v-else>
        <div v-if="showSettings" class="sw-modal-backdrop" @click.self="showSettings = false">
          <div class="sw-modal">
            <button class="sw-btn sw-btn--ghost sw-modal__close" type="button" @click="showSettings = false">✕</button>
            <h3>Системный промпт</h3>
            <textarea v-model="systemPromptText" class="sw-textarea" rows="6" placeholder="Пусто — используется промпт по умолчанию"></textarea>
            <div class="sw-toolbar">
              <button class="sw-btn sw-btn--primary" type="button" :disabled="settingsBusy" @click="saveSystemPrompt">Сохранить</button>
              <button class="sw-btn sw-btn--ghost" type="button" :disabled="settingsBusy" @click="resetSystemPrompt">Сбросить на дефолт</button>
            </div>

            <h3 style="margin-top: 16px">Правила</h3>
            <div v-for="r in rules" :key="r.path" class="sw-form-row" style="align-items: center">
              <span>{{ r.path }}</span>
              <button class="sw-btn sw-btn--ghost" type="button" @click="removeRule(r.path)">Удалить</button>
            </div>
            <p v-if="rules.length === 0" class="sw-hint">Правил нет</p>
            <div class="sw-field">
              <label>Путь (например AGENTS.md)</label>
              <input v-model="newRulePath" class="sw-input" placeholder="правила.md" />
            </div>
            <div class="sw-field">
              <label>Текст правила</label>
              <textarea v-model="newRuleContent" class="sw-textarea" rows="4"></textarea>
            </div>
            <button class="sw-btn sw-btn--primary" type="button" :disabled="settingsBusy" @click="addRule">Добавить правило</button>
            <p v-if="settingsNotice" class="sw-hint">{{ settingsNotice }}</p>
          </div>
        </div>

        <div v-if="!activeDialog && dialogs.length === 0" class="sw-empty">
          Начните новый диалог — задайте вопрос или прикрепите файл ниже.
        </div>

        <div ref="messagesEl" class="sw-agent-messages">
          <template v-if="activeDialog">
            <div
              v-for="(m, i) in activeDialog.messages"
              :key="i"
              class="sw-agent-msg"
              :class="`sw-agent-msg--${m.role}`"
            >
              <div class="sw-agent-msg__role">
                {{ m.role === 'user' ? 'Вы' : m.role === 'assistant' ? 'Агент' : `Инструмент: ${m.tool}` }}
              </div>
              <div class="sw-agent-msg__content">{{ m.content }}</div>
              <a v-if="m.link" :href="m.link.url" target="_blank" rel="noopener" class="sw-btn sw-btn--primary" style="margin-top: 6px; display: inline-block">
                {{ m.link.label }}
              </a>
            </div>
          </template>
          <p v-if="sending" class="sw-hint">{{ progressStatus }}</p>
        </div>

        <div class="sw-agent-input">
          <div v-if="attachedFile" class="sw-hint">
            📎 {{ attachedFile.name }} <button class="sw-btn sw-btn--ghost" type="button" @click="clearAttachment">✕</button>
          </div>
          <textarea
            v-model="inputText"
            class="sw-textarea"
            rows="3"
            placeholder="Спросите агента или прикрепите файл…"
            :disabled="sending"
            @keydown.enter.exact.prevent="sendMessage"
          ></textarea>
          <div class="sw-toolbar">
            <input ref="fileInput" type="file" style="display: none" @change="onFileChange" />
            <button class="sw-btn" type="button" :disabled="sending" @click="fileInput?.click()">📎 Прикрепить файл</button>
            <button class="sw-btn sw-btn--primary" type="button" :disabled="sending || !inputText.trim() || !selectedModel" @click="sendMessage">Отправить</button>
          </div>
          <select v-if="models.length > 0" v-model="selectedModel" class="sw-select" style="width: 100%">
            <option v-for="m in models" :key="m.id" :value="m.id">{{ modelLabel(m) }}</option>
          </select>
          <p v-else class="sw-error">
            Список моделей недоступен (проверьте ключ провайдера в настройках — ⚙ на топбаре). Без выбранной модели отправка отключена.
          </p>
        </div>
      </template>
    </main>
  </div>
</template>
