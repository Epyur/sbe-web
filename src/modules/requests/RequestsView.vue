<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as labApi from '../../api/labApi';
import { errorMessage } from '../../api/http';
import { useCollapsed } from '../../composables/useCollapsed';
import type { Lab, LabMethod, LabObject, LabProject, LabRequest } from '../../types/requests';
import ProjectTree, { type ProjectNode } from './ProjectTree.vue';
import RequestDetail from './RequestDetail.vue';
import RequestCreateModal from './RequestCreateModal.vue';
import GroupsPanel from './GroupsPanel.vue';
import PermissionsPanel from './PermissionsPanel.vue';
import ProjectsPanel from './ProjectsPanel.vue';

const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useCollapsed('sw_sidebar_collapsed_requests');

type SidePanel = 'requests' | 'projects' | 'groups' | 'permissions';

const route = useRoute();
const router = useRouter();

const requests = ref<LabRequest[]>([]);
const projects = ref<LabProject[]>([]);
const labs = ref<Lab[]>([]);
const methods = ref<LabMethod[]>([]);
const objects = ref<LabObject[]>([]);
const loading = ref(false);
const error = ref('');
const role = ref('');
const panel = ref<SidePanel>('requests');
const activeProjectId = ref<number | null>(null);
const showCreate = ref(false);

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

const filteredRequests = computed(() => {
  const list = activeProjectId.value === null
    ? requests.value
    : requests.value.filter((r) => r.project_id === activeProjectId.value);
  // Сначала новые: по дате создания (не по номеру — номер зависит от года/лабы
  // и не всегда монотонно совпадает с реальным порядком создания).
  return [...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
});

function objectName(r: LabRequest): string {
  return objects.value.find((o) => o.id === r.object_id)?.name ?? '';
}
function methodName(r: LabRequest): string {
  return methods.value.find((m) => m.id === r.method_id)?.name ?? '';
}

async function loadAll(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [perm, reqs, projs, l, m, o] = await Promise.all([
      labApi.getMyPermission(),
      labApi.listRequests(),
      labApi.listProjects(),
      labApi.listLabs(),
      labApi.listMethods(),
      labApi.listObjects(),
    ]);
    role.value = perm.role;
    requests.value = reqs;
    projects.value = projs;
    labs.value = l;
    methods.value = m;
    objects.value = o;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

onMounted(loadAll);

function openRequest(id: number): void {
  router.push({ name: 'requests', params: { requestId: String(id) } });
}
function backToList(): void {
  router.push({ name: 'requests', params: {} });
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
      <p v-if="error" class="sw-error">{{ error }}</p>
      <p v-if="loading" class="sw-loading">Загрузка…</p>
      <template v-else-if="panel === 'projects'">
        <ProjectsPanel @changed="loadAll" />
      </template>
      <template v-else-if="panel === 'groups'">
        <GroupsPanel />
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
          :can-edit="canEdit"
          @updated="loadAll"
        />
      </template>
      <template v-else>
        <div class="sw-toolbar">
          <h2 style="flex: 1; margin: 0">Заявки на испытания</h2>
          <button v-if="canEdit" class="sw-btn sw-btn--primary" type="button" @click="showCreate = true">＋ Создать</button>
        </div>
        <p v-if="!filteredRequests.length" class="sw-empty">Заявок нет.</p>
        <div v-for="r in filteredRequests" :key="r.id" class="sw-card sw-req-card" @click="openRequest(r.id)">
          <div class="sw-req-card__number">
            {{ r.customer_number || r.lab_number || `#${r.id}` }}
            <span class="sw-badge" :class="`sw-badge--${r.status}`">{{ r.status }}</span>
          </div>
          <div class="sw-req-card__meta">{{ objectName(r) }} · {{ methodName(r) }}</div>
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
