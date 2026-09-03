<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import * as labApi from '../../api/labApi';
import * as eknApi from '../../api/eknApi';
import { readFireGroupValue } from '../../api/eknApi';
import { errorMessage } from '../../api/http';
import type { Lab, LabGroup, LabMethod, LabObject, LabProject, ObjectCharacteristics } from '../../types/requests';

const props = defineProps<{
  projects: LabProject[];
  defaultProjectId: number | null;
}>();
const emit = defineEmits<{ close: []; created: [] }>();

const labs = ref<Lab[]>([]);
const methods = ref<LabMethod[]>([]);
const objects = ref<LabObject[]>([]);
const groups = ref<LabGroup[]>([]);

const description = ref('');
const projectId = ref<number>(props.defaultProjectId ?? 0);
const groupId = ref<number>(0);
const priority = ref('normal');
const testPurpose = ref('quality_control');

const projectQuery = ref('');
const groupQuery = ref('');
const objectQuery = ref('');

const objectMode = ref<'new' | 'existing'>('new');
const existingObjectId = ref<number>(0);

// --- Объект исследования: ЕКН (серийная продукция) или экспериментальный образец ---
const eknInput = ref('');
const eknHints = ref<eknApi.EknSearchItem[]>([]);
const eknStatusText = ref('');
const eknSnapshot = ref<ObjectCharacteristics['ekn_snapshot'] | null>(null);
const batchNumber = ref('');
const materialName = ref('');
const sampleType = ref<'series' | 'experimental'>('experimental');
const thicknessMm = ref('');
const sampleId = ref('');
let eknTimer: number | undefined;

const isEknMode = computed(() => eknInput.value.trim() !== '');

/** Группа видимости наследуется от проекта (2026-09-03, прямой запрос
 * пользователя) — у каждого проекта своя группа видимости (`LabProject.group_id`,
 * задаётся при создании проекта в sbe-requests), заявка без явного выбора должна
 * попадать в ту же группу, что и её проект. `immediate: true` — применяет и при
 * открытии формы с уже подставленным `defaultProjectId` (переход из карточки
 * проекта), не только при ручной смене селекта. Не блокирует последующий ручной
 * выбор группы пользователем — просто переставляет дефолт при смене проекта. */
watch(() => projectId.value, (id) => {
  const project = props.projects.find((p) => p.id === id);
  groupId.value = project?.group_id ?? 0;
}, { immediate: true });

/** Показатель по методу («ГГ — целевой показатель: ...») — methodId → значение из
 * method.determinable_indicators. Обязателен для каждого выбранного метода, у
 * которого этот список непуст (один ГОСТ может оценивать разные показатели —
 * без явного выбора непонятно, что именно измерялось). */
const selectedTargets = ref<Map<number, string>>(new Map());

const FIRE_GROUP_FIELD_BY_METHOD_CODE: Record<string, string> = {
  'ГГ': 'flame_group',
  'ГВ': 'flammability_gr',
  'РП': 'flame_spread_gr',
};

const selectedPairs = ref<Set<string>>(new Set());
const saving = ref(false);
const error = ref('');

const labById = computed(() => new Map(labs.value.map((l) => [l.id, l])));

const filteredProjects = computed(() => filterList(props.projects, projectQuery.value, projectId.value, (p) => `${p.code} ${p.name}`));
const filteredGroups = computed(() => filterList(groups.value, groupQuery.value, groupId.value, (g) => g.name));
const filteredObjects = computed(() => filterList(objects.value, objectQuery.value, existingObjectId.value, (o) => o.name));

function filterList<T extends { id: number }>(list: T[], query: string, selectedId: number, text: (item: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((item) => item.id === selectedId || text(item).toLowerCase().includes(q));
}

/** Методы сгруппированы по лаборатории (как в Obsidian-плагине) — метод может
 * принадлежать нескольким лабам, заявка фиксирует ровно одну пару (метод, лаба). */
const methodsByLab = computed(() => {
  const map = new Map<number, LabMethod[]>();
  for (const m of methods.value) {
    for (const labId of m.lab_ids) {
      const list = map.get(labId) ?? [];
      list.push(m);
      map.set(labId, list);
    }
  }
  return map;
});

const selectedMethodIds = computed(() => {
  const ids = new Set<number>();
  for (const key of selectedPairs.value) ids.add(Number(key.split(':')[0]));
  return ids;
});

/** Методы, для которых нужно выбрать целевой показатель (determinable_indicators непуст). */
const indicatorGroups = computed(() => {
  const groupsOut: Array<{ methodId: number; code: string; indicators: string[] }> = [];
  for (const mid of selectedMethodIds.value) {
    const m = methods.value.find((md) => md.id === mid);
    if (m && m.determinable_indicators.length > 0) {
      groupsOut.push({ methodId: mid, code: m.code, indicators: m.determinable_indicators });
    }
  }
  return groupsOut;
});

function togglePair(key: string): void {
  if (selectedPairs.value.has(key)) selectedPairs.value.delete(key);
  else selectedPairs.value.add(key);
  applyAutoTargets();
}

function setTarget(methodId: number, value: string): void {
  selectedTargets.value.set(methodId, value);
}

/** Предзаполняет целевой показатель из групп пожарной классификации ЕКН (fire_groups),
 * если распознано и входит в список показателей метода — иначе выбор строго ручной. */
function applyAutoTargets(): void {
  const fireGroups = eknSnapshot.value?.fire_groups;
  for (const { methodId, code, indicators } of indicatorGroups.value) {
    if (selectedTargets.value.has(methodId)) continue;
    const field = FIRE_GROUP_FIELD_BY_METHOD_CODE[code];
    const auto = field ? (fireGroups as Record<string, string> | undefined)?.[field] : undefined;
    if (auto && indicators.includes(auto)) selectedTargets.value.set(methodId, auto);
  }
  // Забываем цели методов, которые больше не выбраны.
  for (const mid of Array.from(selectedTargets.value.keys())) {
    if (!selectedMethodIds.value.has(mid)) selectedTargets.value.delete(mid);
  }
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

function onEknInput(): void {
  eknHints.value = [];
  eknStatusText.value = '';
  eknSnapshot.value = null;
  const q = eknInput.value.trim();
  sampleType.value = q ? 'series' : 'experimental';
  window.clearTimeout(eknTimer);
  if (!q) return;
  eknTimer = window.setTimeout(() => void runEknSearch(q), 400);
}

async function runEknSearch(q: string): Promise<void> {
  try {
    eknHints.value = (await eknApi.search(q)).slice(0, 8);
  } catch {
    eknHints.value = [];
  }
  if (/^\d{6}$/.test(q)) await lookupEknExact(q);
}

async function pickEknHint(item: eknApi.EknSearchItem): Promise<void> {
  eknInput.value = item.ekn;
  eknHints.value = [];
  materialName.value = item.name;
  if (item.thickness) thicknessMm.value = item.thickness;
  eknStatusText.value = `📄 Найдено в справочнике: ${item.name}${item.thickness ? ' · ' + item.thickness : ''}${item.sto_number ? ' · ' + item.sto_number : ''}`;
  await lookupEknExact(item.ekn);
}

async function lookupEknExact(ekn: string): Promise<void> {
  eknStatusText.value = '🔍 Проверяю справочник…';
  const product = await eknApi.getProduct(ekn);
  if (product) {
    materialName.value = product.name || materialName.value;
    if (product.thickness) thicknessMm.value = product.thickness;
    const fireGroups: Record<string, string> = {};
    for (const field of ['flame_group', 'flammability_gr', 'flame_spread_gr']) {
      const v = readFireGroupValue(product.data, field);
      if (v) fireGroups[field] = v;
    }
    eknSnapshot.value = {
      name: product.name,
      thickness: product.thickness,
      sto_number: product.sto_number,
      sto_name: product.sto_name,
      ...(Object.keys(fireGroups).length > 0 ? { fire_groups: fireGroups } : {}),
    };
    eknStatusText.value = `📄 Найдено в справочнике: ${product.name}${product.thickness ? ' · ' + product.thickness : ''}${product.sto_number ? ' · ' + product.sto_number : ''}`;
    applyAutoTargets();
  } else {
    eknSnapshot.value = null;
    eknStatusText.value = '⚠️ Неизвестный продукт, введите название';
  }
}

async function submit(): Promise<void> {
  error.value = '';
  if (selectedPairs.value.size === 0) {
    error.value = 'Выберите хотя бы один метод';
    return;
  }
  for (const { methodId, code } of indicatorGroups.value) {
    if (!selectedTargets.value.has(methodId)) {
      error.value = `Выберите целевой показатель для метода «${code}»`;
      return;
    }
  }

  saving.value = true;
  try {
    let objectId: number;
    let title: string;

    if (objectMode.value === 'existing') {
      if (!existingObjectId.value) {
        error.value = 'Выберите объект исследования';
        saving.value = false;
        return;
      }
      objectId = existingObjectId.value;
      title = objects.value.find((o) => o.id === existingObjectId.value)?.name ?? '';
    } else {
      const name = materialName.value.trim();
      if (!name) {
        error.value = 'Введите название материала';
        saving.value = false;
        return;
      }
      const characteristics: ObjectCharacteristics = {};
      if (isEknMode.value) {
        const batchStr = batchNumber.value.trim();
        if (!batchStr || !/^\d+$/.test(batchStr)) {
          error.value = 'Введите номер партии (целое число) — обязателен при ЕКН';
          saving.value = false;
          return;
        }
        if (!eknSnapshot.value && !thicknessMm.value.trim()) {
          error.value = 'Укажите толщину образца';
          saving.value = false;
          return;
        }
        characteristics.ekn = eknInput.value.trim();
        characteristics.batch_number = Number(batchStr);
        characteristics.sample_type = 'series';
        if (eknSnapshot.value) characteristics.ekn_snapshot = eknSnapshot.value;
        else {
          // Не блокирует создание заявки при ошибке (например, нет прав editor в
          // ekn-service) — как в Obsidian-плагине: карточка в справочнике ЕКН —
          // приятный бонус для следующей заявки, а не обязательное условие этой.
          try {
            await eknApi.setManualProduct(characteristics.ekn, name, thicknessMm.value.trim());
          } catch (e: unknown) {
            console.warn('Заявки: не удалось сохранить ручную карточку ЕКН в sbe-ekn:', errorMessage(e));
          }
        }
      } else {
        const sid = sampleId.value.trim();
        if (!sid) {
          error.value = 'Введите идентификатор образца';
          saving.value = false;
          return;
        }
        characteristics.sample_id = sid;
        characteristics.sample_type = sampleType.value;
      }
      if (thicknessMm.value.trim()) characteristics.thickness_mm = thicknessMm.value.trim();
      if (selectedTargets.value.size > 0) {
        characteristics.target_indicators = Object.fromEntries(selectedTargets.value);
      }
      objectId = await labApi.createObject(name, '', characteristics as unknown as Record<string, unknown>);
      title = name;
    }
    if (!objectId) {
      error.value = 'Не удалось создать объект исследования';
      saving.value = false;
      return;
    }

    const methodPairs = [...selectedPairs.value].map((key) => {
      const [methodId, labId] = key.split(':').map(Number);
      return { method_id: methodId, lab_id: labId };
    });
    await labApi.createRequest({
      title,
      description: description.value.trim(),
      object_id: objectId,
      project_id: projectId.value,
      group_id: groupId.value,
      priority: priority.value,
      test_purpose: testPurpose.value,
      ekn: isEknMode.value && objectMode.value === 'new' ? eknInput.value.trim() : '',
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
          <label>Описание</label>
          <textarea v-model="description" class="sw-textarea"></textarea>
        </div>
        <div class="sw-form-row">
          <div class="sw-field">
            <label>Проект</label>
            <input v-model="projectQuery" class="sw-input" placeholder="🔍 Поиск по проекту…" style="margin-bottom: 4px" />
            <select v-model.number="projectId" class="sw-select">
              <option :value="0">— Публичный —</option>
              <option v-for="p in filteredProjects" :key="p.id" :value="p.id">{{ p.code }}{{ p.name ? ' — ' + p.name : '' }}</option>
            </select>
          </div>
          <div class="sw-field">
            <label>Группа (видимость)</label>
            <input v-model="groupQuery" class="sw-input" placeholder="🔍 Поиск по группе…" style="margin-bottom: 4px" />
            <select v-model.number="groupId" class="sw-select">
              <option :value="0">— Без группы —</option>
              <option v-for="g in filteredGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
          </div>
        </div>
        <div class="sw-form-row">
          <div class="sw-field">
            <label>Приоритет</label>
            <select v-model="priority" class="sw-select">
              <option value="normal">Обычный</option>
              <option value="critical">Критичный</option>
              <option value="blocker">Блокирующий (остановить исполнение других заявок)</option>
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

        <div class="sw-section-title">🔬 Объект исследования</div>
        <div class="sw-toolbar" style="margin-bottom: 10px">
          <label><input type="radio" value="new" v-model="objectMode" /> Новый</label>
          <label><input type="radio" value="existing" v-model="objectMode" /> Существующий</label>
        </div>

        <template v-if="objectMode === 'existing'">
          <div class="sw-field">
            <input v-model="objectQuery" class="sw-input" placeholder="🔍 Поиск по объекту…" style="margin-bottom: 4px" />
            <select v-model.number="existingObjectId" class="sw-select">
              <option :value="0">— Выберите объект —</option>
              <option v-for="o in filteredObjects" :key="o.id" :value="o.id">{{ o.name }}</option>
            </select>
          </div>
        </template>
        <template v-else>
          <div class="sw-field">
            <label>ЕКН (серийная продукция)</label>
            <input
              v-model="eknInput"
              class="sw-input"
              placeholder="Номер ЕКН (например, 068863). Оставьте пустым для экспериментального образца."
              @input="onEknInput"
            />
            <div v-if="eknHints.length" class="sw-card" style="margin-top: 4px; max-height: 200px; overflow-y: auto">
              <div
                v-for="h in eknHints" :key="h.ekn"
                style="padding: 6px 10px; cursor: pointer; border-bottom: 1px solid var(--sw-border)"
                @click="pickEknHint(h)"
              >
                <strong>{{ h.ekn }}</strong> <span class="sw-hint">{{ h.name || '—' }}</span>
              </div>
            </div>
            <p v-if="eknStatusText" class="sw-hint" style="margin-top: 4px">{{ eknStatusText }}</p>
          </div>

          <div v-if="isEknMode" class="sw-field">
            <label>Номер партии (обязателен при ЕКН)</label>
            <!-- НЕ type="number" (2026-09-03, живой баг — см. AGENTS.md): Vue 3
                 у v-model на input type="number" САМ приводит значение к числу,
                 даже без модификатора .number — batchNumber.value переставал быть
                 строкой, и submit() падал на batchNumber.value.trim() с "[x].value.trim
                 is not a function". Цифровая валидация уже есть в JS (/^\d+$/ ниже),
                 спиннер числового поля здесь не нужен. -->
            <input v-model="batchNumber" class="sw-input" type="text" inputmode="numeric" pattern="[0-9]*" />
          </div>

          <div class="sw-form-row">
            <div class="sw-field">
              <label>Название материала</label>
              <input v-model="materialName" class="sw-input" />
            </div>
            <div class="sw-field">
              <label>Толщина образца, мм</label>
              <input v-model="thicknessMm" class="sw-input" />
            </div>
          </div>
          <div class="sw-form-row" v-if="!isEknMode">
            <div class="sw-field">
              <label>Тип объекта</label>
              <select v-model="sampleType" class="sw-select">
                <option value="series">Серийный выпуск</option>
                <option value="experimental">Экспериментальный продукт</option>
              </select>
            </div>
            <div class="sw-field">
              <label>Идентификатор образца</label>
              <input v-model="sampleId" class="sw-input" />
            </div>
          </div>
        </template>

        <div class="sw-section-title">Методы испытаний</div>
        <div v-if="!methods.length" class="sw-hint">Справочник методов пуст.</div>
        <div v-for="[labId, list] in methodsByLab" :key="labId" style="margin-bottom: 10px">
          <div class="sw-hint" style="font-weight: 600; margin-bottom: 4px">🏢 {{ labById.get(labId)?.code }} — {{ labById.get(labId)?.name ?? labId }}</div>
          <label v-for="m in list" :key="`${m.id}:${labId}`" style="display: block; margin-bottom: 4px; margin-left: 12px">
            <input type="checkbox" :checked="selectedPairs.has(`${m.id}:${labId}`)" @change="togglePair(`${m.id}:${labId}`)" />
            {{ m.code }} — {{ m.name }}
          </label>
        </div>

        <template v-if="indicatorGroups.length">
          <div class="sw-section-title">Целевой показатель</div>
          <div v-for="g in indicatorGroups" :key="g.methodId" style="margin-bottom: 10px">
            <div class="sw-hint" style="margin-bottom: 4px">{{ g.code }} — целевой показатель:</div>
            <label v-for="ind in g.indicators" :key="ind" style="display: block; margin-left: 12px">
              <input
                type="radio" :name="`target-${g.methodId}`"
                :checked="selectedTargets.get(g.methodId) === ind"
                @change="setTarget(g.methodId, ind)"
              />
              {{ ind }}
            </label>
          </div>
        </template>

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
