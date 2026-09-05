<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as photoApi from '../../api/photoApi';
import { errorMessage } from '../../api/http';
import { useCollapsed } from '../../composables/useCollapsed';
import { viewAsState } from '../../store/viewAs';
import ViewAsRoleSwitcher from '../../components/ViewAsRoleSwitcher.vue';
import type { MyPermission, PhotoFolder, PhotoItem } from '../../types/photobank';
import FolderTree, { type FolderNode } from './FolderTree.vue';
import PhotoDetailModal from './PhotoDetailModal.vue';
import PhotoThumb from './PhotoThumb.vue';

const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useCollapsed('sw_sidebar_collapsed_photobank');

type SpecialView = 'all' | 'favorites' | 'recent';

const route = useRoute();
const router = useRouter();

const folders = ref<PhotoFolder[]>([]);
const photos = ref<PhotoItem[]>([]);
const loading = ref(false);
const error = ref('');
const query = ref('');
const specialView = ref<SpecialView>('all');
const selected = ref<PhotoItem | null>(null);
const myPermission = ref<MyPermission | null>(null);

async function loadPermission(): Promise<void> {
  try {
    myPermission.value = await photoApi.getMyPermission();
  } catch {
    myPermission.value = null;
  }
}

// Смена «просмотра от лица роли» — сервер начинает фильтровать видимость
// по-другому, поэтому перезагружаем всё, что уже было на экране.
watch(() => viewAsState.photo, () => {
  void loadPermission();
  void loadFolders();
  void loadPhotos();
});

const activeFolderId = computed<number | null>(() => {
  const raw = route.params.folderId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  return id ? Number(id) : null;
});

const folderTree = computed<FolderNode[]>(() => {
  const byId = new Map<number, FolderNode>();
  for (const f of folders.value) byId.set(f.id, { ...f, children: [] });
  const roots: FolderNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
});

const folderTitle = computed(() => {
  if (specialView.value === 'favorites') return 'Избранное';
  if (specialView.value === 'recent') return 'Недавние';
  if (activeFolderId.value) {
    const f = folders.value.find((x) => x.id === activeFolderId.value);
    return f?.name ?? 'Папка';
  }
  return 'Все файлы';
});

async function loadFolders(): Promise<void> {
  try {
    folders.value = await photoApi.listFolders();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}

async function loadPhotos(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const q = query.value.trim();
    if (specialView.value === 'favorites') {
      photos.value = await photoApi.favorites();
    } else if (specialView.value === 'recent') {
      photos.value = await photoApi.recent();
    } else if (q) {
      photos.value = await photoApi.search(q, activeFolderId.value ?? undefined);
    } else {
      // Пустой запрос — не текстовый поиск, а «показать всё»/«показать папку»;
      // GET /api/photo/search с пустым q ничего не возвращает (см. photoApi.pullAll).
      const all = await photoApi.pullAll();
      photos.value = activeFolderId.value
        ? all.filter((p) => p.folder_id === activeFolderId.value)
        : all;
    }
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

function selectFolder(id: number): void {
  specialView.value = 'all';
  query.value = '';
  router.push({ name: 'photobank', params: { folderId: String(id) } });
}

function selectAll(): void {
  specialView.value = 'all';
  query.value = '';
  router.push({ name: 'photobank', params: {} });
}

function selectSpecial(view: SpecialView): void {
  specialView.value = view;
  router.push({ name: 'photobank', params: {} });
}

let searchTimer: number | undefined;
function onSearchInput(): void {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    specialView.value = 'all';
    void loadPhotos();
  }, 300);
}

watch(activeFolderId, () => {
  if (specialView.value === 'all') void loadPhotos();
});

const thumbCache = reactive(new Map<number, string>());
function openPhoto(p: PhotoItem): void {
  selected.value = p;
}

// Ленивая загрузка превью «в видимой области + следующие 10» (2026-09-05) —
// один IntersectionObserver на весь грид; как только карточка с индексом i
// попадает в видимость, разрешаем загрузку карточкам с индексом < i+1+LOOKAHEAD
// (по порядку в списке, не по пикселям — точнее соответствует «10 фото», а не
// «N пикселей», при разном числе колонок в гриде). loadUpTo только растёт,
// пока не сменится список фото (новая папка/поиск — сброс).
const LOOKAHEAD = 10;
const loadUpTo = ref(LOOKAHEAD);
let observer: IntersectionObserver | undefined;
const elByIndex = new Map<number, Element>();
const indexByEl = new Map<Element, number>();

function setCardRef(el: Element | null, index: number): void {
  const prev = elByIndex.get(index);
  if (prev && prev !== el) {
    observer?.unobserve(prev);
    indexByEl.delete(prev);
  }
  if (el) {
    elByIndex.set(index, el);
    indexByEl.set(el, index);
    observer?.observe(el);
  } else {
    elByIndex.delete(index);
  }
}

watch(photos, () => {
  loadUpTo.value = LOOKAHEAD;
});

onMounted(() => {
  void loadPermission();
  void loadFolders();
  void loadPhotos();
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const index = indexByEl.get(entry.target);
      if (index === undefined) continue;
      const candidate = index + 1 + LOOKAHEAD;
      if (candidate > loadUpTo.value) loadUpTo.value = candidate;
    }
  }, { rootMargin: '100px 0px' });
  for (const el of elByIndex.values()) observer.observe(el);
});

onUnmounted(() => {
  window.clearTimeout(searchTimer);
  observer?.disconnect();
});

</script>

<template>
  <div class="sw-layout">
    <aside class="sw-sidebar" :class="{ 'is-collapsed': sidebarCollapsed }">
      <button class="sw-sidebar__toggle" type="button" :title="sidebarCollapsed ? 'Развернуть' : 'Свернуть'" @click="toggleSidebar">
        {{ sidebarCollapsed ? '»' : '«' }}
      </button>
      <template v-if="!sidebarCollapsed">
        <div class="sw-field">
          <input
            v-model="query"
            class="sw-input"
            placeholder="Поиск по фотобанку…"
            @input="onSearchInput"
          />
        </div>
        <ul class="sw-tree">
          <li>
            <div
              class="sw-tree__item"
              :class="{ 'sw-tree__item--active': specialView === 'all' && !activeFolderId }"
              @click="selectAll"
            >
              🗂️ Все файлы
            </div>
          </li>
          <li>
            <div
              class="sw-tree__item"
              :class="{ 'sw-tree__item--active': specialView === 'favorites' }"
              @click="selectSpecial('favorites')"
            >
              ⭐ Избранное
            </div>
          </li>
          <li>
            <div
              class="sw-tree__item"
              :class="{ 'sw-tree__item--active': specialView === 'recent' }"
              @click="selectSpecial('recent')"
            >
              🕐 Недавние
            </div>
          </li>
        </ul>
        <div class="sw-section-title" style="margin-top: 16px">Папки</div>
        <FolderTree
          :nodes="folderTree"
          :active-id="specialView === 'all' ? activeFolderId : null"
          @select="selectFolder"
        />
      </template>
    </aside>
    <section class="sw-content">
      <ViewAsRoleSwitcher
        v-if="myPermission"
        app="photo"
        :real-role="myPermission.real_role"
        :roles="['admin', 'editor', 'commenter', 'viewer']"
      />
      <h2>{{ folderTitle }}</h2>
      <p v-if="error" class="sw-error">{{ error }}</p>
      <p v-if="loading" class="sw-loading">Загрузка…</p>
      <p v-else-if="!photos.length" class="sw-empty">Ничего не найдено.</p>
      <div v-else class="sw-grid">
        <div
          v-for="(p, i) in photos"
          :key="p.id"
          class="sw-card sw-photo-card"
          :ref="(el) => setCardRef(el as Element | null, i)"
          @click="openPhoto(p)"
        >
          <PhotoThumb :photo="p" :cache="thumbCache" :should-load="i < loadUpTo" />
          <div class="sw-photo-card__body">
            <div class="sw-photo-card__title">{{ p.title || p.file_name }}</div>
            <div class="sw-photo-card__meta">
              <span>♥ {{ p.likes_count }}</span>
              <span>⬇ {{ p.download_count }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
    <PhotoDetailModal v-if="selected" :photo="selected" @close="selected = null" @changed="loadPhotos" />
  </div>
</template>
