<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import QRCode from 'qrcode';
import * as labApi from '../../api/labApi';
import { errorMessage } from '../../api/http';
import { base64ToBlob, downloadBlob } from '../../utils/download';
import { printQrLabels } from './qrPrint';
import type { AuditLogEntry, Lab, LabGroup, LabMethod, LabObject, LabProject, LabRequest } from '../../types/requests';

const props = defineProps<{
  requestId: number;
  labs: Lab[];
  methods: LabMethod[];
  objects: LabObject[];
  /** Для отображения названия проекта/группы заявки (паритет с Obsidian-
   *  плагином sbe-requests, renderRequestDetail) — переиспользуем списки,
   *  уже загруженные в RequestsView.vue (listProjects/listGroups), отдельного
   *  API-вызова здесь не заводим. */
  projects: LabProject[];
  groups: LabGroup[];
  canEdit: boolean;
  /** Только admin (или superadmin, клэмпнутый до admin на вебе) может реально
   *  менять статус — editor видит те же кнопки, но неактивные (см. AGENTS.md,
   *  «управление статусом заявки»). Ограничение проверяется и на сервере
   *  (POST /api/lab/requests/{id}/status требует admin), это не только вёрстка. */
  canChangeStatus: boolean;
  /** Email текущего пользователя (perm.email из RequestsView.loadAll) —
   *  для клиентской проверки «владелец заявки может дозаполнить целевой
   *  показатель» (паритет с my-email в ProjectsPanel/GroupsPanel). Реальное
   *  ограничение — на сервере (owner_email заявки либо staff/admin). */
  myEmail: string;
}>();
const emit = defineEmits<{ updated: [] }>();

const request = ref<LabRequest | null>(null);
const loading = ref(false);
const error = ref('');
const saving = ref(false);

const protocolHtml = ref('');
const protocolLoading = ref(false);
const auditLog = ref<AuditLogEntry[]>([]);
const auditOpen = ref(false);
const qrDataUrl = ref('');
const files = ref<LabRequest['files']>([]);
const uploading = ref(false);

const object = computed(() => props.objects.find((o) => o.id === request.value?.object_id));
const method = computed(() => props.methods.find((m) => m.id === request.value?.method_id));
const lab = computed(() => props.labs.find((l) => l.id === request.value?.lab_id));
const project = computed(() => props.projects.find((p) => p.id === request.value?.project_id));
const group = computed(() => props.groups.find((g) => g.id === request.value?.group_id));
const requestNumber = computed(() => request.value?.customer_number || request.value?.lab_number || '');

/** Название + код метода в одну строку (паритет с methodName() плагина). */
const methodLabel = computed(() => {
  const m = method.value;
  if (!m) return '';
  return `${m.code}${m.name ? ' — ' + m.name : ''}`;
});

/** Целевой показатель, выбранный при создании заявки для её метода —
 * characteristics.target_indicators[method_id] объекта, на котором проводится
 * испытание (значение может отличаться для разных методов одного объекта). */
const targetIndicator = computed(() => {
  const methodId = request.value?.method_id;
  if (methodId === undefined) return '';
  return object.value?.characteristics?.target_indicators?.[String(methodId)] ?? '';
});

/** Владелец заявки (или staff/admin через canEdit) может дозаполнить
 * недостающий целевой показатель, только пока он реально не задан и
 * соответствие ещё не посчитано («Не оценивается» — типичный признак
 * отсутствующего целевого показателя у метода с несколькими determinable_indicators). */
const canFillTargetIndicator = computed(() => {
  return (
    !targetIndicator.value
    && request.value?.compliance === 'Не оценивается'
    && (request.value?.owner_email === props.myEmail || props.canEdit)
  );
});
const selectedIndicator = ref('');
const savingIndicator = ref(false);

async function saveTargetIndicator(): Promise<void> {
  if (!request.value || !selectedIndicator.value) return;
  savingIndicator.value = true;
  error.value = '';
  try {
    await labApi.setTargetIndicator(request.value.id, selectedIndicator.value);
    selectedIndicator.value = '';
    await load();
    emit('updated');
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    savingIndicator.value = false;
  }
}

/** Дедлайн — день создания + 10 рабочих дней (≈14 календарных, по решению пользователя). */
const DEADLINE_DAYS = 14;
const deadline = computed(() => {
  if (!request.value?.created_at) return '';
  const created = new Date(request.value.created_at);
  if (Number.isNaN(created.getTime())) return '';
  return new Date(created.getTime() + DEADLINE_DAYS * 24 * 60 * 60 * 1000).toISOString();
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  protocolHtml.value = '';
  auditLog.value = [];
  auditOpen.value = false;
  try {
    request.value = await labApi.getRequest(props.requestId);
    files.value = request.value.files ?? [];
    if (requestNumber.value) {
      qrDataUrl.value = await QRCode.toDataURL(requestNumber.value, { margin: 1, width: 160 });
    }
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

watch(() => props.requestId, load);
onMounted(load);

async function saveField(field: 'description' | 'priority' | 'test_purpose', value: string): Promise<void> {
  if (!request.value) return;
  saving.value = true;
  try {
    await labApi.updateRequest(request.value.id, { [field]: value });
    request.value[field] = value;
    emit('updated');
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}

async function setStatus(status: string): Promise<void> {
  if (!request.value) return;
  saving.value = true;
  try {
    await labApi.setRequestStatus(request.value.id, status);
    request.value.status = status;
    emit('updated');
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}

async function loadProtocol(): Promise<void> {
  if (!request.value) return;
  protocolLoading.value = true;
  try {
    const html = await labApi.getProtocolHTML(request.value.id);
    // Ответ — цельный HTML-документ со своим <style> (глобальные селекторы,
    // напр. table/td) — как и в Obsidian-плагине (renderShortView), нельзя
    // биндить v-html на него напрямую: протекло бы в остальной DOM портала.
    // Парсим и берём только doc.body.innerHTML, без <head>/<style>.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    protocolHtml.value = doc.body.innerHTML;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    protocolLoading.value = false;
  }
}

async function downloadProtocolDocx(): Promise<void> {
  if (!request.value) return;
  try {
    const base64 = await labApi.getProtocolDocxBase64(request.value.id);
    downloadBlob(
      base64ToBlob(base64, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      `protocol-${requestNumber.value || request.value.id}.docx`,
    );
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}

async function downloadExportXlsx(): Promise<void> {
  if (!request.value) return;
  try {
    const base64 = await labApi.getExportXlsxBase64(request.value.id);
    downloadBlob(
      base64ToBlob(base64, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      `export-${requestNumber.value || request.value.id}.xlsx`,
    );
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}

async function downloadFile(fileKey: string, fileName: string): Promise<void> {
  try {
    const url = await labApi.downloadFileBlobUrl(fileKey);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}

async function onFilePicked(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !request.value) return;
  uploading.value = true;
  try {
    const res = await labApi.uploadFile(file, request.value.id);
    files.value = [...files.value, { file_key: res.file_key, file_name: res.file_name, file_size: res.file_size, file_url: res.file_url }];
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    uploading.value = false;
    input.value = '';
  }
}

async function toggleAudit(): Promise<void> {
  auditOpen.value = !auditOpen.value;
  if (auditOpen.value && !auditLog.value.length && request.value) {
    try {
      auditLog.value = await labApi.listAuditLog(request.value.id);
    } catch (e: unknown) {
      error.value = errorMessage(e);
    }
  }
}

/** Раскрытые «подробнее» (до/после) записи результата в истории — паритет
 * с плагином (detailsBtn в renderRequestDetail). */
const expandedAudit = ref<Set<number>>(new Set());
function toggleAuditDetails(id: number): void {
  if (expandedAudit.value.has(id)) expandedAudit.value.delete(id);
  else expandedAudit.value.add(id);
}
function formatAuditValues(v: Record<string, unknown> | undefined): string {
  if (!v || Object.keys(v).length === 0) return '(пусто)';
  return Object.entries(v).map(([k, val]) => `${k}=${JSON.stringify(val)}`).join(', ');
}

function printQr(): void {
  if (!request.value) return;
  void printQrLabels([{
    number: requestNumber.value || `#${request.value.id}`,
    title: object.value?.name || request.value.title || '',
  }]);
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch {
    return iso;
  }
}
</script>

<template>
  <div>
    <p v-if="loading" class="sw-loading">Загрузка…</p>
    <template v-else-if="request">
      <h3 v-if="object?.name">{{ object.name }}</h3>
      <h2>
        {{ requestNumber || `#${request.id}` }}{{ request.external_id ? ` (${request.external_id})` : '' }}
        <span class="sw-badge" :class="`sw-badge--${request.status}`">{{ request.status }}</span>
      </h2>
      <p class="sw-hint">{{ methodLabel }} <template v-if="lab?.name">@ {{ lab.name }}</template></p>
      <p v-if="error" class="sw-error">{{ error }}</p>

      <div class="sw-form-row">
        <div class="sw-field">
          <label>Проект</label>
          <div>{{ project ? `${project.code}${project.name ? ' — ' + project.name : ''}` : '— Публичный —' }}</div>
        </div>
        <div class="sw-field">
          <label>Группа</label>
          <div>{{ group ? group.name : '— Без группы —' }}</div>
        </div>
      </div>
      <div class="sw-form-row">
        <div class="sw-field" v-if="request.ekn">
          <label>ЕКН</label>
          <div>{{ request.ekn }}</div>
        </div>
        <div class="sw-field" v-if="object?.characteristics?.batch_number !== undefined">
          <label>Номер партии</label>
          <div>{{ object?.characteristics?.batch_number }}</div>
        </div>
        <div class="sw-field" v-if="object?.characteristics?.sample_id">
          <label>Идентификатор образца</label>
          <div>{{ object?.characteristics?.sample_id }}</div>
        </div>
      </div>
      <div class="sw-field">
        <label>Заказчик</label>
        <div>{{ request.owner_email || '—' }}</div>
      </div>

      <div class="sw-field">
        <label>Название</label>
        <div>{{ request.title }}</div>
      </div>
      <div class="sw-field">
        <label>Описание</label>
        <textarea
          class="sw-textarea"
          :value="request.description"
          :disabled="!canEdit || saving"
          @change="saveField('description', ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
      </div>
      <div class="sw-form-row">
        <div class="sw-field">
          <label>Приоритет</label>
          <select
            class="sw-select"
            :value="request.priority"
            :disabled="!canEdit || saving"
            @change="saveField('priority', ($event.target as HTMLSelectElement).value)"
          >
            <option value="normal">Обычный</option>
            <option value="critical">Критичный</option>
            <option value="blocker">Блокирующий</option>
          </select>
        </div>
        <div class="sw-field">
          <label>Цель испытания</label>
          <select
            class="sw-select"
            :value="request.test_purpose"
            :disabled="!canEdit || saving"
            @change="saveField('test_purpose', ($event.target as HTMLSelectElement).value)"
          >
            <option value="quality_control">Текущий контроль</option>
            <option value="rnd">НИОКР</option>
            <option value="certification">Сертификация</option>
            <option value="declaration">Декларирование</option>
          </select>
        </div>
      </div>

      <div class="sw-form-row">
        <div class="sw-field">
          <label>Дата создания</label>
          <div>{{ formatDate(request.created_at) }}</div>
        </div>
        <div class="sw-field">
          <label>Дедлайн</label>
          <div>{{ deadline ? formatDate(deadline) : '—' }}</div>
        </div>
        <div class="sw-field">
          <label>Дата завершения</label>
          <div>{{ request.completed_at ? formatDate(request.completed_at) : '—' }}</div>
        </div>
      </div>

      <div v-if="canEdit" class="sw-toolbar">
        <button class="sw-btn" :class="{ 'sw-btn--status-current': request.status === 'new' }" type="button" :disabled="!canChangeStatus || saving || request.status === 'new'" @click="setStatus('new')">Новая</button>
        <button class="sw-btn" :class="{ 'sw-btn--status-current': request.status === 'processing' }" type="button" :disabled="!canChangeStatus || saving || request.status === 'processing'" @click="setStatus('processing')">В работе</button>
        <button class="sw-btn" :class="{ 'sw-btn--status-current': request.status === 'completed' }" type="button" :disabled="!canChangeStatus || saving || request.status === 'completed'" @click="setStatus('completed')">Завершена</button>
      </div>

      <div class="sw-section-title">Метод испытаний</div>
      <p class="sw-hint">{{ methodLabel || '—' }}</p>
      <table class="sw-table">
        <thead>
          <tr><th>Номер заказчику</th><th>Номер лаборатории</th></tr>
        </thead>
        <tbody>
          <tr><td>{{ request.customer_number || '—' }}</td><td>{{ request.lab_number || '—' }}</td></tr>
        </tbody>
      </table>
      <p v-if="targetIndicator" class="sw-hint" style="margin-top: 8px">🎯 Целевой показатель: {{ targetIndicator }}</p>
      <div v-else-if="canFillTargetIndicator" class="sw-form-row" style="margin-top: 8px; align-items: flex-end">
        <div class="sw-field">
          <label>🎯 Целевой показатель не задан — выберите</label>
          <select class="sw-select" v-model="selectedIndicator" :disabled="savingIndicator">
            <option value="" disabled>— выберите показатель —</option>
            <option v-for="ind in method?.determinable_indicators ?? []" :key="ind" :value="ind">{{ ind }}</option>
          </select>
        </div>
        <button
          class="sw-btn sw-btn--primary"
          type="button"
          :disabled="!selectedIndicator || savingIndicator"
          @click="saveTargetIndicator"
        >💾 Сохранить и пересчитать</button>
      </div>

      <div class="sw-section-title">Результаты</div>
      <button class="sw-btn" type="button" :disabled="protocolLoading" @click="loadProtocol">
        {{ protocolHtml ? 'Обновить' : 'Показать результаты' }}
      </button>
      <div v-if="protocolHtml" class="sw-protocol-html" v-html="protocolHtml" style="margin-top: 12px" />
      <div class="sw-toolbar" style="margin-top: 12px">
        <button class="sw-btn" type="button" @click="downloadProtocolDocx">📄 Скачать протокол (Word)</button>
        <button class="sw-btn" type="button" @click="downloadExportXlsx">📊 Скачать таблицу (Excel)</button>
      </div>

      <div class="sw-section-title">Файлы</div>
      <ul>
        <li v-for="f in files" :key="f.file_key">
          <a href="#" @click.prevent="downloadFile(f.file_key, f.file_name)">{{ f.file_name }}</a>
          <span class="sw-hint"> ({{ Math.round(f.file_size / 1024) }} КБ)</span>
        </li>
      </ul>
      <input v-if="canEdit" type="file" :disabled="uploading" @change="onFilePicked" />

      <div class="sw-section-title">QR-этикетка</div>
      <img v-if="qrDataUrl" :src="qrDataUrl" alt="QR" style="width: 120px" />
      <div>
        <button class="sw-btn" type="button" @click="printQr">🖨 Печать этикетки</button>
      </div>

      <div class="sw-section-title" style="cursor: pointer" @click="toggleAudit">
        📜 История {{ auditOpen ? '▾' : '▸' }}
      </div>
      <div v-if="auditOpen">
        <p v-if="!auditLog.length" class="sw-hint">Пока нет записей.</p>
        <div v-for="e in auditLog" :key="e.id" class="sw-comment">
          <span class="sw-comment__author">{{ e.who }}</span>
          <span class="sw-comment__date">{{ formatDate(e.created_at) }}</span>
          <div v-if="e.kind === 'status'">Статус: {{ e.old_status }} → {{ e.new_status }}</div>
          <template v-else>
            <div>
              Результат: серия {{ e.series_num }} ({{ e.kind === 'result_created' ? 'создана' : 'изменена' }})
              <button class="sw-btn sw-btn--ghost" type="button" @click="toggleAuditDetails(e.id)">подробнее</button>
            </div>
            <div v-if="expandedAudit.has(e.id)" class="sw-hint">
              <div>До: {{ formatAuditValues(e.values_before) }}</div>
              <div>После: {{ formatAuditValues(e.values_after) }}</div>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>
