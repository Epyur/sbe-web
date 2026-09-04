<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as labApi from '../../api/labApi';
import { errorMessage } from '../../api/http';
import { base64ToBlob, downloadBlob } from '../../utils/download';
import { useCollapsed } from '../../composables/useCollapsed';
import { viewAsState } from '../../store/viewAs';
import ViewAsRoleSwitcher from '../../components/ViewAsRoleSwitcher.vue';
import { printQrLabels } from './qrPrint';
import type { Lab, LabGroup, LabMethod, LabObject, LabProject, LabRequest } from '../../types/requests';
import ProjectTree, { type ProjectNode } from './ProjectTree.vue';
import RequestDetail from './RequestDetail.vue';
import RequestCreateModal from './RequestCreateModal.vue';
import RequestFilters, { emptyRequestFilters, type RequestFiltersState } from './RequestFilters.vue';
import GroupsPanel from './GroupsPanel.vue';
import PermissionsPanel from './PermissionsPanel.vue';
import ProjectsPanel from './ProjectsPanel.vue';

const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useCollapsed('sw_sidebar_collapsed_requests');

type SidePanel = 'requests' | 'projects' | 'groups' | 'permissions';

const route = useRoute();
const router = useRouter();

const requests = ref<LabRequest[]>([]);
const projects = ref<LabProject[]>([]);
const groups = ref<LabGroup[]>([]);
const labs = ref<Lab[]>([]);
const methods = ref<LabMethod[]>([]);
const objects = ref<LabObject[]>([]);
const loading = ref(false);
const error = ref('');
const role = ref('');
const realRole = ref('');
const myEmail = ref('');
const panel = ref<SidePanel>('requests');
const activeProjectId = ref<number | null>(null);
const showCreate = ref(false);
const selectedForPrint = ref<Set<number>>(new Set());
const filters = ref<RequestFiltersState>(emptyRequestFilters());

const canEdit = computed(() => role.value === 'editor' || role.value === 'admin');
const isAdmin = computed(() => role.value === 'admin');

const selectedRequestId = computed<number | null>(() => {
  const raw = route.params.requestId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  return id ? Number(id) : null;
});

const projectTree = computed<ProjectNode[]>(() => {
  const byId = new Map<number, ProjectNode>();
  for (const p of projects.value) byId.set(p.id, { ...p, children: [] });
  const roots: ProjectNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id)!.children.push(node);
    else roots.push(node);
  }
  return roots;
});

/** Список заявок с применёнными фильтрами (2026-09-04) — activeProjectId
 * (сайдбар) AND 6 полей панели фильтров (RequestFilters.vue), все условия
 * через AND, пустое поле не ограничивает. Полностью на клиенте — сервер
 * /api/lab/requests query-параметров не читает. */
const filteredRequests = computed(() => {
  let list = activeProjectId.value === null
    ? requests.value
    : requests.value.filter((r) => r.project_id === activeProjectId.value);

  const f = filters.value;
  if (f.dateFrom) {
    const from = new Date(f.dateFrom).getTime();
    list = list.filter((r) => new Date(r.created_at).getTime() >= from);
  }
  if (f.dateTo) {
    // «До» включительно — конец указанного дня.
    const to = new Date(f.dateTo).getTime() + 24 * 60 * 60 * 1000 - 1;
    list = list.filter((r) => new Date(r.created_at).getTime() <= to);
  }
  if (f.methodId) {
    list = list.filter((r) => r.method_id === f.methodId);
  }
  if (f.status === 'active') {
    list = list.filter((r) => r.status !== 'completed');
  } else if (f.status === 'completed') {
    list = list.filter((r) => r.status === 'completed');
  }
  if (f.objectName.trim()) {
    const q = f.objectName.trim().toLowerCase();
    list = list.filter((r) => objectName(r).toLowerCase().includes(q));
  }
  if (f.identifier.trim()) {
    const q = f.identifier.trim().toLowerCase();
    list = list.filter((r) =>
      r.customer_number.toLowerCase().includes(q)
      || r.lab_number.toLowerCase().includes(q)
      || r.external_id.toLowerCase().includes(q)
      || String(r.id).includes(q));
  }
  if (f.batch.trim()) {
    const q = f.batch.trim().toLowerCase();
    list = list.filter((r) => {
      const batch = objects.value.find((o) => o.id === r.object_id)?.characteristics?.batch_number;
      return batch !== undefined && String(batch).toLowerCase().includes(q);
    });
  }
  if (f.ownerEmail.trim()) {
    const q = f.ownerEmail.trim().toLowerCase();
    list = list.filter((r) => r.owner_email.toLowerCase().includes(q));
  }

  // Сначала новые: по дате создания (не по номеру — номер зависит от года/лабы
  // и не всегда монотонно совпадает с реальным порядком создания).
  return [...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
});

function objectName(r: LabRequest): string {
  return objects.value.find((o) => o.id === r.object_id)?.name ?? '';
}
function requestNumber(r: LabRequest): string {
  return r.customer_number || r.lab_number || `#${r.id}`;
}
function toggleSelectForPrint(id: number, checked: boolean): void {
  if (checked) selectedForPrint.value.add(id); else selectedForPrint.value.delete(id);
}
function clearSelectForPrint(): void {
  selectedForPrint.value.clear();
}
/** Выделить все заявки из текущего отфильтрованного списка (filteredRequests) —
 * а не вообще все заявки в системе: пользователь ожидает, что «выделить все»
 * действует на то, что он сейчас видит с учётом активных фильтров. */
function selectAllFiltered(): void {
  for (const r of filteredRequests.value) selectedForPrint.value.add(r.id);
}
/** Печать листа QR для отмеченных заявок — как в Obsidian-плагине (checkbox
 * в списке → «Печать листа QR»). */
async function printSelected(): Promise<void> {
  const chosen = filteredRequests.value.filter((r) => selectedForPrint.value.has(r.id));
  await printQrLabels(chosen.map((r) => ({ number: requestNumber(r), title: objectName(r) || r.title })));
}
const exportingSummary = ref(false);
/** Сводный .xlsx по всем отмеченным заявкам сразу (POST export-summary.xlsx) —
 * отдельная кнопка от «Печать листа QR», не связана с ней. */
async function downloadSelectedSummary(): Promise<void> {
  const ids = Array.from(selectedForPrint.value);
  if (!ids.length) return;
  exportingSummary.value = true;
  error.value = '';
  try {
    const base64 = await labApi.getSummaryExportXlsxBase64(ids);
    const today = new Date().toISOString().slice(0, 10);
    downloadBlob(
      base64ToBlob(base64, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      `svodka_${ids.length}_zayavok_${today}.xlsx`,
    );
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    exportingSummary.value = false;
  }
}
function methodName(r: LabRequest): string {
  return methods.value.find((m) => m.id === r.method_id)?.name ?? '';
}

async function loadAll(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [perm, reqs, projs, grps, l, m, o] = await Promise.all([
      labApi.getMyPermission(),
      labApi.listRequests(),
      labApi.listProjects(),
      labApi.listGroups(),
      labApi.listLabs(),
      labApi.listMethods(),
      labApi.listObjects(),
    ]);
    role.value = perm.role;
    realRole.value = perm.real_role;
    myEmail.value = perm.email;
    requests.value = reqs;
    projects.value = projs;
    groups.value = grps;
    labs.value = l;
    methods.value = m;
    objects.value = o;
    const validIds = new Set(reqs.map((r) => r.id));
    for (const id of Array.from(selectedForPrint.value)) if (!validIds.has(id)) selectedForPrint.value.delete(id);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

onMounted(loadAll);

// Смена «просмотра от лица роли» — сервер фильтрует видимость иначе,
// перезагружаем список заявок/проектов заново.
watch(() => viewAsState.lab, () => { void loadAll(); });

function openRequest(id: number): void {
  router.push({ name: 'requests', params: { requestId: String(id) } });
}
function backToList(): void {
  router.push({ name: 'requests', params: {} });
}

/** Проект, выбранный в сайдбаре, удалён из ProjectsPanel.vue — сбрасываем
 * фильтр по нему (сам проект уже пропал из списка, оставлять activeProjectId
 * указывающим в никуда — список заявок молча покажет 0 записей без объяснений). */
function onProjectDeleted(id: number): void {
  if (activeProjectId.value === id) activeProjectId.value = null;
}

// ---- Результат/Соответствие — hover-подсказка с «Справкой» из протокола
// (только для «Не соответствует», см. AGENTS.md на бэкенде). Кэш по
// request.id — повторное наведение не должно повторять запрос.
const hoveredHelpId = ref<number | null>(null);
const helpCache = ref<Map<number, string>>(new Map());
const helpFetching = ref<Set<number>>(new Set());

async function loadHelp(id: number): Promise<void> {
  if (helpCache.value.has(id) || helpFetching.value.has(id)) return;
  helpFetching.value.add(id);
  try {
    const html = await labApi.getProtocolHelpHTML(id);
    // Ответ — цельный HTML-документ со своим <style>, как и у getProtocolHTML()
    // в RequestDetail.vue — v-html только на doc.body.innerHTML, не на «сырой» html.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    helpCache.value.set(id, doc.body.innerHTML);
  } catch (e: unknown) {
    helpCache.value.set(id, `<p>${errorMessage(e)}</p>`);
  } finally {
    helpFetching.value.delete(id);
  }
}

function onComplianceEnter(r: LabRequest): void {
  if (r.compliance !== 'Не соответствует') return;
  hoveredHelpId.value = r.id;
  void loadHelp(r.id);
}
function onComplianceLeave(): void {
  hoveredHelpId.value = null;
}

watch(showCreate, (v) => {
  if (!v) void loadAll();
});
</script>

<template>
  <div class="sw-layout">
    <aside class="sw-sidebar" :class="{ 'is-collapsed': sidebarCollapsed }">
      <button class="sw-sidebar__toggle" type="button" :title="sidebarCollapsed ? 'Развернуть' : 'Свернуть'" @click="toggleSidebar">
        {{ sidebarCollapsed ? '»' : '«' }}
      </button>
      <template v-if="!sidebarCollapsed">
        <ul class="sw-tree">
          <li>
            <div
              class="sw-tree__item"
              :class="{ 'sw-tree__item--active': panel === 'requests' && activeProjectId === null }"
              @click="panel = 'requests'; activeProjectId = null; backToList()"
            >
              🧪 Все заявки
            </div>
          </li>
          <li v-if="canEdit">
            <div class="sw-tree__item" :class="{ 'sw-tree__item--active': panel === 'projects' }" @click="panel = 'projects'">
              📁 Проекты
            </div>
          </li>
          <li>
            <div class="sw-tree__item" :class="{ 'sw-tree__item--active': panel === 'groups' }" @click="panel = 'groups'">
              👥 Группы
            </div>
          </li>
          <li v-if="isAdmin">
            <div class="sw-tree__item" :class="{ 'sw-tree__item--active': panel === 'permissions' }" @click="panel = 'permissions'">
              🔐 Права доступа
            </div>
          </li>
        </ul>
        <div class="sw-section-title">Проекты</div>
        <ProjectTree
          :nodes="projectTree"
          :active-id="panel === 'requests' ? activeProjectId : null"
          @select="(id) => { panel = 'requests'; activeProjectId = id; backToList(); }"
        />
      </template>
    </aside>
    <section class="sw-content">
      <ViewAsRoleSwitcher app="lab" :real-role="realRole" :roles="['admin', 'editor', 'viewer']" />
      <p v-if="error" class="sw-error">{{ error }}</p>
      <p v-if="loading" class="sw-loading">Загрузка…</p>
      <template v-else-if="panel === 'projects'">
        <ProjectsPanel :my-email="myEmail" :is-admin="isAdmin" @changed="loadAll" @deleted="onProjectDeleted" />
      </template>
      <template v-else-if="panel === 'groups'">
        <GroupsPanel :my-email="myEmail" :is-admin="isAdmin" @changed="loadAll" />
      </template>
      <template v-else-if="panel === 'permissions'">
        <PermissionsPanel />
      </template>
      <template v-else-if="selectedRequestId">
        <button class="sw-btn" type="button" @click="backToList">← К списку заявок</button>
        <RequestDetail
          :request-id="selectedRequestId"
          :labs="labs"
          :methods="methods"
          :objects="objects"
          :projects="projects"
          :groups="groups"
          :can-edit="canEdit"
          :can-change-status="isAdmin"
          :my-email="myEmail"
          @updated="loadAll"
        />
      </template>
      <template v-else>
        <div class="sw-toolbar">
          <h2 style="flex: 1; margin: 0">Заявки на испытания</h2>
          <button v-if="canEdit" class="sw-btn sw-btn--primary" type="button" @click="showCreate = true">＋ Создать</button>
        </div>
        <div v-if="canEdit && selectedForPrint.size > 0" class="sw-toolbar" style="margin-bottom: 12px">
          <button class="sw-btn sw-btn--ghost" type="button" @click="selectAllFiltered">☑ Выделить все</button>
          <button class="sw-btn sw-btn--primary" type="button" @click="printSelected">
            🖶 Печать листа QR ({{ selectedForPrint.size }})
          </button>
          <button class="sw-btn sw-btn--primary" type="button" :disabled="exportingSummary" @click="downloadSelectedSummary">
            📊 {{ exportingSummary ? 'Формирование…' : `Скачать результаты (${selectedForPrint.size})` }}
          </button>
          <button class="sw-btn sw-btn--ghost" type="button" @click="clearSelectForPrint">✖ Снять выбор</button>
        </div>
        <RequestFilters :methods="methods" @change="filters = $event" />
        <p v-if="!filteredRequests.length" class="sw-empty">Заявок нет.</p>
        <div v-for="r in filteredRequests" :key="r.id" class="sw-card sw-req-card" @click="openRequest(r.id)">
          <div style="display: flex; align-items: center; gap: 8px">
            <input
              v-if="canEdit"
              type="checkbox"
              :checked="selectedForPrint.has(r.id)"
              @click.stop
              @change="toggleSelectForPrint(r.id, ($event.target as HTMLInputElement).checked)"
            />
            <div class="sw-req-card__number">
              {{ requestNumber(r) }}{{ r.external_id ? ` (${r.external_id})` : '' }}
              <span class="sw-badge" :class="`sw-badge--${r.status}`">{{ r.status }}</span>
            </div>
          </div>
          <div class="sw-req-card__meta">{{ objectName(r) }} · {{ methodName(r) }}</div>
          <div
            v-if="r.result"
            class="sw-req-card__result"
            :class="{
              'sw-req-card__result--ok': r.compliance === 'Соответствует',
              'sw-req-card__result--bad': r.compliance === 'Не соответствует',
              'sw-req-card__result--unknown': r.compliance === 'Не оценивается',
            }"
          >Результат: {{ r.result }}</div>
          <div
            v-if="r.compliance"
            class="sw-req-card__compliance"
            :class="{
              'sw-req-card__compliance--ok': r.compliance === 'Соответствует',
              'sw-req-card__compliance--bad': r.compliance === 'Не соответствует',
            }"
            @click.stop
            @mouseenter="onComplianceEnter(r)"
            @mouseleave="onComplianceLeave"
          >
            Соответствие: {{ r.compliance }}
            <div v-if="r.compliance === 'Не соответствует' && hoveredHelpId === r.id" class="sw-req-tooltip">
              <p v-if="helpFetching.has(r.id) && !helpCache.has(r.id)" class="sw-hint">Загрузка…</p>
              <div v-else-if="helpCache.has(r.id)" class="sw-protocol-html" v-html="helpCache.get(r.id)"></div>
            </div>
          </div>
        </div>
      </template>
    </section>
    <RequestCreateModal
      v-if="showCreate"
      :projects="projects"
      :default-project-id="activeProjectId"
      @close="showCreate = false"
      @created="showCreate = false"
    />
  </div>
</template>
