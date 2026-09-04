<script lang="ts">
/** Состояние панели фильтров списка заявок — 6 независимых полей (2026-09-04,
 * прямой запрос пользователя: раздельные фильтры, а не одна общая строка
 * поиска). Все условия комбинируются через AND, пустое поле — не ограничивает.
 * Фильтрация целиком на клиенте (см. RequestsView.vue, filteredRequests) —
 * сервер не поддерживает никаких query-параметров для списка заявок.
 * (Value-экспорты не допускаются внутри <script setup> — отсюда отдельный
 * обычный <script> блок для функции-фабрики значений по умолчанию.) */
export interface RequestFiltersState {
  dateFrom: string;
  dateTo: string;
  /** 0 — «Все методы». */
  methodId: number;
  /** 'all' | 'active' (new/processing) | 'completed' — 2026-09-04, прямой запрос
   * пользователя. */
  status: 'all' | 'active' | 'completed';
  objectName: string;
  identifier: string;
  batch: string;
  ownerEmail: string;
}

export function emptyRequestFilters(): RequestFiltersState {
  return {
    dateFrom: '', dateTo: '', methodId: 0, status: 'all',
    objectName: '', identifier: '', batch: '', ownerEmail: '',
  };
}
</script>

<script setup lang="ts">
import { reactive, watch } from 'vue';
import type { LabMethod } from '../../types/requests';

defineProps<{
  /** Справочник методов — переиспользуем уже загруженный в RequestsView список
   * (тот же, что и RequestCreateModal.vue использует для выбора методов при
   * создании заявки), отдельного API-вызова для фильтра не заводим. */
  methods: LabMethod[];
}>();
const emit = defineEmits<{ change: [RequestFiltersState] }>();

const filters = reactive<RequestFiltersState>(emptyRequestFilters());

watch(filters, () => emit('change', { ...filters }), { deep: true });

function reset(): void {
  Object.assign(filters, emptyRequestFilters());
}
</script>

<template>
  <div class="sw-card sw-filters">
    <div class="sw-filters__grid">
      <div class="sw-field">
        <label>Дата создания</label>
        <div class="sw-filters__date-range">
          <input v-model="filters.dateFrom" class="sw-input" type="date" title="от" />
          <input v-model="filters.dateTo" class="sw-input" type="date" title="до" />
        </div>
      </div>
      <div class="sw-field">
        <label>Метод</label>
        <select v-model.number="filters.methodId" class="sw-select">
          <option :value="0">— Все —</option>
          <option v-for="m in methods" :key="m.id" :value="m.id">{{ m.code }} — {{ m.name }}</option>
        </select>
      </div>
      <div class="sw-field">
        <label>Статус</label>
        <select v-model="filters.status" class="sw-select">
          <option value="all">Все</option>
          <option value="active">Активные</option>
          <option value="completed">Завершённые</option>
        </select>
      </div>
      <div class="sw-field">
        <label>Название объекта</label>
        <input v-model="filters.objectName" class="sw-input" placeholder="Поиск по названию…" />
      </div>
      <div class="sw-field">
        <label>Идентификатор</label>
        <input v-model="filters.identifier" class="sw-input" placeholder="№ заказчика / лаб. / внешний / ID" />
      </div>
      <div class="sw-field">
        <label>Партия</label>
        <input v-model="filters.batch" class="sw-input" placeholder="Номер партии…" />
      </div>
      <div class="sw-field">
        <label>Заказчик</label>
        <input v-model="filters.ownerEmail" class="sw-input" placeholder="email@…" />
      </div>
    </div>
    <div class="sw-toolbar" style="margin-bottom: 0">
      <button class="sw-btn sw-btn--ghost" type="button" @click="reset">✖ Сбросить фильтры</button>
    </div>
  </div>
</template>
