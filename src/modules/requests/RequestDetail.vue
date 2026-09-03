<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import QRCode from 'qrcode';
import * as labApi from '../../api/labApi';
import { errorMessage } from '../../api/http';
import { printQrLabels } from './qrPrint';
import type { AuditLogEntry, Lab, LabMethod, LabObject, LabRequest } from '../../types/requests';

const props = defineProps<{
  requestId: number;
  labs: Lab[];
  methods: LabMethod[];
  objects: LabObject[];
  canEdit: boolean;
  /** Только admin (или superadmin, клэмпнутый до admin на вебе) может реально
   *  менять статус — editor видит те же кнопки, но неактивные (см. AGENTS.md,
   *  «управление статусом заявки»). Ограничение проверяется и на сервере
   *  (POST /api/lab/requests/{id}/status требует admin), это не только вёрстка. */
  canChangeStatus: boolean;
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
const requestNumber = computed(() => request.value?.customer_number || request.value?.lab_number || '');

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
    protocolHtml.value = await labApi.getProtocolHTML(request.value.id);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    protocolLoading.value = false;
  }
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
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
      <h2>
        {{ requestNumber || `#${request.id}` }}
        <span class="sw-badge" :class="`sw-badge--${request.status}`">{{ request.status }}</span>
      </h2>
      <p class="sw-hint">{{ object?.name }} · {{ method?.name }} @ {{ lab?.name }}</p>
      <p v-if="error" class="sw-error">{{ error }}</p>

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

      <div class="sw-section-title">Результаты</div>
      <button class="sw-btn" type="button" :disabled="protocolLoading" @click="loadProtocol">
        {{ protocolHtml ? 'Обновить' : 'Показать результаты' }}
      </button>
      <div v-if="protocolHtml" v-html="protocolHtml" style="margin-top: 12px" />
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
          <div v-else>Результат: серия {{ e.series_num }} ({{ e.kind === 'result_created' ? 'создана' : 'изменена' }})</div>
        </div>
      </div>
    </template>
  </div>
</template>
