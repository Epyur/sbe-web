<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import * as labApi from '../../api/labApi';
import { errorMessage } from '../../api/http';
import type { Lab, LabGroup, LabMethod, LabObject, LabProject } from '../../types/requests';

const props = defineProps<{
  projects: LabProject[];
  defaultProjectId: number | null;
}>();
const emit = defineEmits<{ close: []; created: [] }>();

const labs = ref<Lab[]>([]);
const methods = ref<LabMethod[]>([]);
const objects = ref<LabObject[]>([]);
const groups = ref<LabGroup[]>([]);

const title = ref('');
const description = ref('');
const projectId = ref<number>(props.defaultProjectId ?? 0);
const groupId = ref<number>(0);
const priority = ref('normal');
const testPurpose = ref('quality_control');

const objectMode = ref<'existing' | 'new'>('new');
const existingObjectId = ref<number>(0);
const newObjectName = ref('');
const newObjectDescription = ref('');

const selectedPairs = ref<Set<string>>(new Set());
const saving = ref(false);
const error = ref('');

const labById = computed(() => new Map(labs.value.map((l) => [l.id, l])));

/** Строки «метод @ лаба» — метод показывается под каждой привязанной лабой отдельно
 * (метод может принадлежать нескольким лабораториям, заявка фиксирует ровно одну пару). */
const methodLabRows = computed(() => {
  const rows: Array<{ key: string; methodId: number; labId: number; label: string }> = [];
  for (const m of methods.value) {
    for (const labId of m.lab_ids) {
      const lab = labById.value.get(labId);
      rows.push({ key: `${m.id}:${labId}`, methodId: m.id, labId, label: `${m.name} — ${lab?.name ?? labId}` });
    }
  }
  return rows;
});

function togglePair(key: string): void {
  if (selectedPairs.value.has(key)) selectedPairs.value.delete(key);
  else selectedPairs.value.add(key);
}

async function loadRefs(): Promise<void> {
  try {
    [labs.value, methods.value, objects.value, groups.value] = await Promise.all([
      labApi.listLabs(),
      labApi.listMethods(),
      labApi.listObjects(),
      labApi.listGroups(),
    ]);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}

onMounted(loadRefs);

async function submit(): Promise<void> {
  error.value = '';
  if (!title.value.trim()) {
    error.value = 'Укажите название заявки';
    return;
  }
  if (selectedPairs.value.size === 0) {
    error.value = 'Выберите хотя бы один метод';
    return;
  }
  saving.value = true;
  try {
    let objectId = existingObjectId.value;
    if (objectMode.value === 'new') {
      if (!newObjectName.value.trim()) {
        error.value = 'Укажите название объекта исследования';
        saving.value = false;
        return;
      }
      objectId = await labApi.createObject(newObjectName.value.trim(), newObjectDescription.value.trim(), {});
    }
    if (!objectId) {
      error.value = 'Выберите или создайте объект исследования';
      saving.value = false;
      return;
    }
    const methodPairs = [...selectedPairs.value].map((key) => {
      const [methodId, labId] = key.split(':').map(Number);
      return { method_id: methodId, lab_id: labId };
    });
    await labApi.createRequest({
      title: title.value.trim(),
      description: description.value.trim(),
      object_id: objectId,
      project_id: projectId.value,
      group_id: groupId.value,
      priority: priority.value,
      test_purpose: testPurpose.value,
      ekn: '',
      external_id: '',
      methods: methodPairs,
    });
    emit('created');
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="sw-modal-backdrop" @click.self="emit('close')">
    <div class="sw-modal">
      <button class="sw-btn sw-modal__close" type="button" @click="emit('close')">✕</button>
      <h2>Новая заявка</h2>
      <form @submit.prevent="submit">
        <div class="sw-field">
          <label>Название заявки</label>
          <input v-model="title" class="sw-input" />
        </div>
        <div class="sw-field">
          <label>Описание</label>
          <textarea v-model="description" class="sw-textarea"></textarea>
        </div>
        <div class="sw-form-row">
          <div class="sw-field">
            <label>Проект</label>
            <select v-model.number="projectId" class="sw-select">
              <option :value="0">— Публичный —</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }} ({{ p.code }})</option>
            </select>
          </div>
          <div class="sw-field">
            <label>Группа (видимость)</label>
            <select v-model.number="groupId" class="sw-select">
              <option :value="0">— Без группы —</option>
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
          </div>
        </div>
        <div class="sw-form-row">
          <div class="sw-field">
            <label>Приоритет</label>
            <select v-model="priority" class="sw-select">
              <option value="normal">Обычный</option>
              <option value="critical">Критичный</option>
              <option value="blocker">Блокирующий</option>
            </select>
          </div>
          <div class="sw-field">
            <label>Цель испытания</label>
            <select v-model="testPurpose" class="sw-select">
              <option value="quality_control">Текущий контроль</option>
              <option value="rnd">НИОКР</option>
              <option value="certification">Сертификация</option>
              <option value="declaration">Декларирование</option>
            </select>
          </div>
        </div>

        <div class="sw-section-title">Объект исследования</div>
        <div class="sw-toolbar">
          <label><input type="radio" value="new" v-model="objectMode" /> Новый</label>
          <label><input type="radio" value="existing" v-model="objectMode" /> Существующий</label>
        </div>
        <template v-if="objectMode === 'new'">
          <div class="sw-form-row">
            <div class="sw-field">
              <label>Название</label>
              <input v-model="newObjectName" class="sw-input" />
            </div>
            <div class="sw-field">
              <label>Описание</label>
              <input v-model="newObjectDescription" class="sw-input" />
            </div>
          </div>
        </template>
        <template v-else>
          <div class="sw-field">
            <select v-model.number="existingObjectId" class="sw-select">
              <option :value="0">— Выберите объект —</option>
              <option v-for="o in objects" :key="o.id" :value="o.id">{{ o.name }}</option>
            </select>
          </div>
        </template>

        <div class="sw-section-title">Методы испытаний</div>
        <div v-if="!methodLabRows.length" class="sw-hint">Справочник методов пуст.</div>
        <label v-for="row in methodLabRows" :key="row.key" style="display: block; margin-bottom: 6px">
          <input type="checkbox" :checked="selectedPairs.has(row.key)" @change="togglePair(row.key)" />
          {{ row.label }}
        </label>

        <p v-if="error" class="sw-error">{{ error }}</p>
        <div class="sw-toolbar" style="margin-top: 16px">
          <button class="sw-btn sw-btn--primary" type="submit" :disabled="saving">
            {{ saving ? 'Создаём…' : 'Создать заявку' }}
          </button>
          <button class="sw-btn" type="button" @click="emit('close')">Отмена</button>
        </div>
      </form>
    </div>
  </div>
</template>
