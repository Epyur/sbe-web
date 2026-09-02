<script setup lang="ts">
import type { PhotoFolder } from '../../types/photobank';

export interface FolderNode extends PhotoFolder {
  children: FolderNode[];
}

defineProps<{
  nodes: FolderNode[];
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
        📁 {{ node.name }}
      </div>
      <div v-if="node.children.length" class="sw-tree__children">
        <FolderTree :nodes="node.children" :active-id="activeId" @select="(id) => emit('select', id)" />
      </div>
    </li>
  </ul>
</template>
