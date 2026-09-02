<script setup lang="ts">
import type { LabProject } from '../../types/requests';

export interface ProjectNode extends LabProject {
  children: ProjectNode[];
}

defineProps<{
  nodes: ProjectNode[];
  activeId: number | null;
}>();

const emit = defineEmits<{ select: [id: number] }>();
</script>

<template>
  <ul class="sw-tree">
    <li v-for="node in nodes" :key="node.id">
      <div
        class="sw-tree__item"
        :class="{ 'sw-tree__item--active': activeId === node.id }"
        @click="emit('select', node.id)"
      >
        📂 {{ node.name }} <span class="sw-hint">({{ node.code }})</span>
      </div>
      <div v-if="node.children.length" class="sw-tree__children">
        <ProjectTree :nodes="node.children" :active-id="activeId" @select="(id) => emit('select', id)" />
      </div>
    </li>
  </ul>
</template>
