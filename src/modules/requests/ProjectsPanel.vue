<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import * as labApi from '../../api/labApi';
import { errorMessage } from '../../api/http';
import type { LabGroup, LabProject } from '../../types/requests';

const props = defineProps<{
  /** Email текущего пользователя и признак admin/superadmin (клэмпнутый до
   *  admin на вебе) — приходят из RequestsView.vue (getMyPermission() уже
   *  вызван там), чтобы не дублировать запрос в каждой панели. Нужны для
   *  клиентского гейта кнопки удаления (сервер всё равно перепроверяет 403). */
  myEmail: string;
  isAdmin: boolean;
}>();
const emit = defineEmits<{ changed: []; deleted: [id: number] }>();

const projects = ref<LabProject[]>([]);
const groups = ref<LabGroup[]>([]);
const error = ref('');
const busy = ref(false);
const showCreate = ref(false);
const editingId = ref<number | null>(null);

const form = ref({
  parent_id: 0, code: '', name: '', description: '', is_ekn: false, group_id: 0,
  mail_trigger_ekn: '', mail_trigger_sender: '',
});
const editForm = ref({
  code: '', name: '', description: '', group_id: 0, parent_id: 0,
  mail_trigger_ekn: '', mail_trigger_sender: '',
});

const groupName = computed(() => (id: number) => groups.value.find((g) => g.id === id)?.name ?? '— Публичный —');

// Сначала новые, потом старые — тот же общий принцип, что и в списке заявок.
const sortedProjects = computed(() =>
  [...projects.value].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
);

/** Доступные варианты родителя при редактировании проекта `id`: сам проект и
 * его потомки исключены (иначе получится цикл — сервер такое всё равно отклонит,
 * но нет смысла предлагать в списке заведомо невалидный выбор). */
function parentOptionsFor(id: number): LabProject[] {
  const excluded = new Set<number>([id]);
  let added = true;
  while (added) {
    added = false;
    for (const p of projects.value) {
      if (excluded.has(p.parent_id) && !excluded.has(p.id)) {
        excluded.add(p.id);
        added = true;
      }
    }
  }
  return projects.value.filter((p) => !excluded.has(p.id));
}

async function load(): Promise<void> {
  try {
    [projects.value, groups.value] = await Promise.all([labApi.listProjects(), labApi.listGroups()]);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}
onMounted(load);

function resetForm(): void {
  form.value = {
    parent_id: 0, code: '', name: '', description: '', is_ekn: false, group_id: 0,
    mail_trigger_ekn: '', mail_trigger_sender: '',
  };
}

async function createProject(): Promise<void> {
  if (!form.value.code.trim()) {
    error.value = 'Укажите код проекта';
    return;
  }
  busy.value = true;
  try {
    await labApi.createProject({
      parent_id: form.value.parent_id,
      code: form.value.code.trim(),
      name: form.value.name.trim(),
      description: form.value.description.trim(),
      is_ekn: form.value.is_ekn,
      group_id: form.value.group_id,
      mail_trigger_ekn: form.value.mail_trigger_ekn.trim(),
      mail_trigger_sender: form.value.mail_trigger_sender.trim(),
    });
    resetForm();
    showCreate.value = false;
    await load();
    emit('changed');
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

function startEdit(p: LabProject): void {
  editingId.value = p.id;
  editForm.value = {
    code: p.code, name: p.name, description: p.description, group_id: p.group_id, parent_id: p.parent_id,
    mail_trigger_ekn: p.mail_trigger_ekn, mail_trigger_sender: p.mail_trigger_sender,
  };
}

async function saveEdit(id: number): Promise<void> {
  busy.value = true;
  try {
    await labApi.updateProject(id, { ...editForm.value });
    editingId.value = null;
    await load();
    emit('changed');
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

function canDelete(p: LabProject): boolean {
  return p.owner_email === props.myEmail || props.isAdmin;
}

async function deleteProject(p: LabProject): Promise<void> {
  const label = `${p.code}${p.name ? ' — ' + p.name : ''}`;
  if (!window.confirm(`Удалить проект «${label}»? Действие необратимо.`)) return;
  busy.value = true;
  try {
    await labApi.deleteProject(p.id);
    await load();
    emit('changed');
    emit('deleted', p.id);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div>
    <div class="sw-toolbar">
      <h2 style="flex: 1; margin: 0">Проекты</h2>
      <button class="sw-btn sw-btn--primary" type="button" @click="showCreate = !showCreate">
        {{ showCreate ? 'Отмена' : '＋ Создать проект' }}
      </button>
    </div>
    <p v-if="error" class="sw-error">{{ error }}</p>

    <form v-if="showCreate" class="sw-card" style="padding: 16px; margin-bottom: 16px" @submit.prevent="createProject">
      <div class="sw-form-row">
        <div class="sw-field">
          <label>Родительский проект (для подпроекта)</label>
          <select v-model.number="form.parent_id" class="sw-select">
            <option :value="0">— Корневой проект —</option>
            <option v-for="p in sortedProjects" :key="p.id" :value="p.id">{{ p.code }} — {{ p.name }}</option>
          </select>
        </div>
        <div class="sw-field">
          <label>Группа (видимость)</label>
          <select v-model.number="form.group_id" class="sw-select">
            <option :value="0">— Публичный —</option>
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </div>
      </div>
      <div class="sw-form-row">
        <div class="sw-field">
          <label>Код проекта (уникальный)</label>
          <input v-model="form.code" class="sw-input" placeholder="Например: ЕКН-2026-001" />
        </div>
        <div class="sw-field">
          <label>Название</label>
          <input v-model="form.name" class="sw-input" />
        </div>
      </div>
      <div class="sw-field">
        <label>Описание</label>
        <textarea v-model="form.description" class="sw-textarea"></textarea>
      </div>
      <label><input v-model="form.is_ekn" type="checkbox" /> Проект по ЕКН</label>

      <div class="sw-section-title">Источник — почта (авто-маршрутизация писем)</div>
      <p class="sw-hint">
        Заявка, пришедшая по почте без своего ЕКН-автопроекта, попадёт в этот проект,
        если совпадёт хотя бы одно условие ниже. Пусто — проект не участвует в
        автоматическом распределении почты.
      </p>
      <div class="sw-form-row">
        <div class="sw-field">
          <label>Триггер: точный ЕКН образца</label>
          <input v-model="form.mail_trigger_ekn" class="sw-input" placeholder="Например: 123456" />
        </div>
        <div class="sw-field">
          <label>Триггер: отправитель или домен</label>
          <input v-model="form.mail_trigger_sender" class="sw-input" placeholder="user@company.ru или @company.ru" />
        </div>
      </div>

      <div class="sw-toolbar" style="margin-top: 12px">
        <button class="sw-btn sw-btn--primary" type="submit" :disabled="busy">Создать</button>
      </div>
    </form>

    <table class="sw-table">
      <thead>
        <tr>
          <th>Код</th><th>Название</th><th>Родительский проект</th><th>Группа</th>
          <th>Триггер ЕКН</th><th>Триггер отправителя</th><th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in sortedProjects" :key="p.id">
          <template v-if="editingId === p.id">
            <td><input v-model="editForm.code" class="sw-input" /></td>
            <td><input v-model="editForm.name" class="sw-input" /></td>
            <td>
              <select v-model.number="editForm.parent_id" class="sw-select">
                <option :value="0">— Корневой проект —</option>
                <option v-for="opt in parentOptionsFor(p.id)" :key="opt.id" :value="opt.id">{{ opt.code }} — {{ opt.name }}</option>
              </select>
            </td>
            <td>
              <select v-model.number="editForm.group_id" class="sw-select">
                <option :value="0">— Публичный —</option>
                <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
              </select>
            </td>
            <td><input v-model="editForm.mail_trigger_ekn" class="sw-input" placeholder="ЕКН" /></td>
            <td><input v-model="editForm.mail_trigger_sender" class="sw-input" placeholder="user@… или @домен" /></td>
            <td>
              <button class="sw-btn sw-btn--primary" type="button" :disabled="busy" @click="saveEdit(p.id)">💾</button>
              <button class="sw-btn" type="button" @click="editingId = null">✕</button>
            </td>
          </template>
          <template v-else>
            <td>{{ p.code }}</td>
            <td>{{ p.name }}</td>
            <td>{{ p.parent_id ? (projects.find((x) => x.id === p.parent_id)?.name ?? `#${p.parent_id}`) : '— Корневой —' }}</td>
            <td>{{ groupName(p.group_id) }}</td>
            <td>{{ p.mail_trigger_ekn || '—' }}</td>
            <td>{{ p.mail_trigger_sender || '—' }}</td>
            <td>
              <button class="sw-btn" type="button" @click="startEdit(p)">✎</button>
              <button
                v-if="canDelete(p)"
                class="sw-btn sw-btn--danger"
                type="button"
                :disabled="busy"
                @click="deleteProject(p)"
              >🗑 Удалить</button>
            </td>
          </template>
        </tr>
      </tbody>
    </table>
  </div>
</template>
