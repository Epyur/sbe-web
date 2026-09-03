<script setup lang="ts">
import { viewAsState, setViewAsRole, type ViewAsApp } from '../store/viewAs';

const props = defineProps<{
  app: ViewAsApp;
  realRole: string;
  /** Роли ниже superadmin, доступные для симуляции (порядок — от старшей к младшей). */
  roles: string[];
}>();

function onChange(e: Event): void {
  setViewAsRole(props.app, (e.target as HTMLSelectElement).value);
}
</script>

<template>
  <div v-if="realRole === 'superadmin'" class="sw-view-as">
    <span class="sw-hint">Просмотр от лица роли:</span>
    <select class="sw-select" :value="viewAsState[app]" @change="onChange" style="max-width: 200px">
      <option value="">Обычный (суперадмин)</option>
      <option v-for="r in roles" :key="r" :value="r">{{ r }}</option>
    </select>
    <span v-if="viewAsState[app]" class="sw-badge sw-badge--processing">
      Вы видите как «{{ viewAsState[app] }}»
    </span>
  </div>
</template>
