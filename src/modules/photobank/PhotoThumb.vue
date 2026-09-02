<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import * as photoApi from '../../api/photoApi';
import type { PhotoItem } from '../../types/photobank';

// Blob-URL кладётся в общий `cache` (владеет им PhotobankView) и намеренно не
// освобождается здесь при размонтировании карточки — список тот же самый
// фото может быть перерисован при повторном поиске, повторная загрузка
// миниатюры того же файла того не стоит.
const props = defineProps<{ photo: PhotoItem; cache: Map<number, string> }>();

const src = ref(props.cache.get(props.photo.id) ?? '');

async function load(): Promise<void> {
  const key = props.photo.thumb_key || props.photo.file_key;
  if (!key) return;
  const cached = props.cache.get(props.photo.id);
  if (cached) {
    src.value = cached;
    return;
  }
  try {
    const url = await photoApi.fetchFileBlobUrl(key, true);
    props.cache.set(props.photo.id, url);
    src.value = url;
  } catch {
    src.value = '';
  }
}

watch(() => props.photo.id, load);
onMounted(load);
</script>

<template>
  <img v-if="src" class="sw-photo-card__thumb" :src="src" alt="" loading="lazy" />
  <div v-else class="sw-photo-card__thumb" />
</template>
